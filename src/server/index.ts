import ansis from 'ansis'
import fs from 'fs'
import path from 'path'
import { log2Text } from 'src/utils/log-2-text'
import { Readable } from 'stream'
import type { Logger, Plugin } from 'vite'
import zlib from 'zlib'
import { AnalyzerNode, JS_EXTENSIONS, createAnalyzerModule } from './analyzer-module'
import type { AnalyzerPluginInternalAPI, AnalyzerPluginOptions, AnalyzerStore } from './interface'
import { opener } from './opener'
import { createServer, ensureEmptyPort, renderView } from './render'
import { searchForWorkspaceRoot } from './search-root'
import { analyzerDebug, convertBytes, fsp, stringToByte } from './shared'

const isCI = !!process.env.CI

const defaultOptions: AnalyzerPluginOptions = {
  analyzerMode: 'server',
  defaultSizes: 'stat',
  summary: true
}

export function openBrowser(address: string) {
  opener([address])
}

/**
 * Uint8Array 数据管理器
 * 一次性可读流, 通过 into 方法写入, 通过 refresh 方法刷新, 并重新加载之前的数据
 */
function arena() {
  let hasSet = false
  let binary: Uint8Array
  return {
    // readable stream 可读流
    rs: new Readable(),
    // 写入可读流
    into(b: string | Uint8Array) {
      if (hasSet) { return }
      this.rs.push(b)
      this.rs.push(null)
      if (!binary) {
        binary = stringToByte(b)
      }
      hasSet = true
    },
    // 刷新可读流
    refresh() {
      hasSet = false
      this.rs = new Readable()
      this.into(binary)
    }
  }
}

const formatNumber = (number: number | string) => ansis.dim(ansis.bold(number + ''))

const formatSize = (number: number) => formatNumber(convertBytes(number))

const generateSummaryMessage = (modules: AnalyzerNode[]) => {
  const count = modules.length
  const meta = modules.reduce((acc, module) => {
    acc.gzip += module.gzipSize
    acc.parsed += module.parsedSize
    acc.map += module.mapSize
    return acc
  }, {
    gzip: 0,
    parsed: 0,
    map: 0
  })
  const extra = [
    meta.gzip && `gzip: ${formatSize(meta.gzip)}`,
    meta.map && `map: ${formatSize(meta.map)}`
  ].filter(Boolean).join(' | ')
  return `${formatNumber(count)} chunks of ${formatSize(meta.parsed)} ${extra ? `(${extra})` : ''}`
}

// Design for race condition is called
let callCount = 0

// There is a possibility that multiple called.
// Thre're two scenarios:
// First, user create multiple build task each config object is isolated.
// Second, user use the same config object but the build task is parallel. (Like vitepress or vuepress)
// However, about sourcemap state should always declare in the plugin object to makesure those scenarios can be handled.
// callCount is specifically for the Second scenario.
// If someone has a better idea, PR welcome.

function analyzer(opts?: AnalyzerPluginOptions) {
  opts = { ...defaultOptions, ...opts }

  const { reportTitle = 'vite-bundle-analyzer' } = opts
  const analyzerModule = createAnalyzerModule({ gzip: opts.gzipOptions, brotli: opts.brotliOptions })
  const store: AnalyzerStore = { analyzerModule, lastSourcemapOption: false, hasSetupSourcemapOption: false }
  let defaultWd = process.cwd()
  let hasViteReporter = true
  let logger: Logger
  let workspaceRoot = process.cwd()
  const preferLivingServer = opts.analyzerMode === 'server' || opts.analyzerMode === 'static'
  const preferSilent = opts.analyzerMode === 'json' || opts.analyzerMode === 'static'

  const b = arena()

  const plugin: Plugin<AnalyzerPluginInternalAPI> = {
    name: 'vite-bundle-anlyzer', // 插件名
    apply: 'build', // 插件的生效时机
    enforce: 'post', // 插件的执行顺序
    api: { // 暴漏给其他插件的方法和属性
      store,
      processModule: () => analyzerModule.processModule()
    },

    /**
     * config 钩子作用: 配置解析过程中运行, 允许修改插件配置
     * 主要目的是 hack 了一下 rollup 的 config 文件
     * 如果 没开 sourcemap 就设置成 hidden,
     * 如果 sourcemap 设置成了 inline 会有告警
     * config.build.sourcemap 的选项有:
     *  - false 不生成
     *  - true 生成独立的 sourcemap 文件
     *  - inline 将 sourcemap 嵌入到生成的 js 文件中, 不生成独立的 .map 文件
     *  - hidden 生成独立的 sourcemap 文件, 但不会在 js 中添加对 sourcemap 的引用
     * 使用了 ansis 做控制台的输出
     */
    config(config) {
      // For some reason, like `vitepress`,`vuepress` and other static site generator etc. They might use the same config object
      // for multiple build process. So we should ensure the sourcemap option is set correctly.
      if (!config.build) {
        config.build = {}
      }
      if ('sourcemap' in config.build && !store.hasSetupSourcemapOption) {
        // true: hidden / true
        // inline 会导致 打出来的 js 统计不准
        store.lastSourcemapOption = typeof config.build.sourcemap === 'boolean'
          ? config.build.sourcemap
          : config.build.sourcemap === 'hidden'
        if (config.build.sourcemap === 'inline') {
          // verbose the warning
          console.warn('vite-bundle-analyzer: sourcemap option is set to `inline`, it might cause the result inaccurate.')
        }
      }
      if (config.build) {
        if (typeof config.build.sourcemap === 'boolean') {
          config.build.sourcemap = true
        } else {
          config.build.sourcemap = 'hidden'
        }
        analyzerDebug(`plugin status is ${config.build.sourcemap ? ansis.green('ok') : ansis.red('invalid')}`)
      }
      store.hasSetupSourcemapOption = true
      return config
    },
    /**
     * 在配置完全确定后运行, 用于读取最终配置
     * 主要用于初始化 analyzerModule 和 reporter
     */
    configResolved(config) {
      defaultWd = path.resolve(config.root, config.build.outDir ?? '')
      logger = config.logger
      workspaceRoot = searchForWorkspaceRoot(config.root)
      analyzerModule.workspaceRoot = workspaceRoot
      if (opts.summary) {
        const reporter = config.plugins.find((plugin) => plugin.name === 'vite:reporter')
        hasViteReporter = !!reporter?.writeBundle
        if (reporter?.writeBundle) {
          const originalFunction = typeof reporter.writeBundle === 'function'
            ? reporter.writeBundle
            : reporter.writeBundle?.handler
          const fn: Plugin['writeBundle'] = async function writeBundle(...args) {
            await originalFunction?.apply(this, args)
            logger.info(generateSummaryMessage(analyzerModule.modules))
          }

          if (typeof reporter.writeBundle !== 'function') {
            reporter.writeBundle.handler = fn
          } else {
            reporter.writeBundle = fn
          }
        }
      }
    },
    /**
     * 在 Vite 完成资源生成并准备输出最终的打包文件时被调用
     * 通过这个钩子对生成的 chunk 进行最后的修改/分析/生成额外的文件
     */
    async generateBundle(_, outputBundle) {
      log2Text(outputBundle)
      // 绑定 整个 plugin 到 analyzerModule 中
      analyzerModule.installPluginContext(this)
      // 保存 OutputBundle 原始数据
      analyzerModule.setupRollupChunks(outputBundle)
      // const cleanup: Array<{ bundle: OutputChunk | OutputAsset, sourcemapFileName: string | undefined }> = []
      // After consider. I trust process chunk is enough. (If you don't think it's right. PR welcome.)
      // A funny thing is that 'Import with Query Suffixes' vite might think the worker is assets
      // So we should wrapper them as a chunk node.
      // outputBundle 是一个对象, key 是每个 chunk 的 dir/fileName
      for (const bundleName in outputBundle) {
        const bundle = outputBundle[bundleName]
        // bundle 中是包含源代码的, 是打包出来东西的全部信息, 将 bundle 作为模块添加进 analyzerModule 中
        await analyzerModule.addModule(bundle)
      }
      if (!store.lastSourcemapOption) {
        // https://262.ecma-international.org/5.1/#sec-12.6.4
        for (const bundleName in outputBundle) {
          const bundle = outputBundle[bundleName]
          // 判断文件后缀名是不是 .js .mjs .cjs
          if (JS_EXTENSIONS.test(bundle.fileName)) {
            // 尝试根据 fileName 猜 map 的路径, 注意此处的 fileName 是 路径 + 文件名
            const possiblePath = bundle.fileName + '.map'
            if (possiblePath in outputBundle) {
              // 从 outputBundle 中将 sourcemap 文件剔除
              Reflect.deleteProperty(outputBundle, possiblePath)
            }
            if (bundle.type === 'chunk') {
              // 说明有单独的 map 属性, 然后直接将 map 删除掉
              Reflect.deleteProperty(bundle, 'map')
            }
          }
        }
      }
    },
    /**
     * 构建过程完全结束之后, 执行一些收尾逻辑
     * 比如: 资源清理, 通知, 出发后续任务
     * 是 rollup 插件提供的钩子, 在 vite 中同样适用
     * opts.analyzerMode 是分析产物的形式
     * opts.analyzerMode: server | static | json | Function
     * - server 会起个静态服务器来展示代码结构
     * - static 将分析结果放到 html 文件中, 使用 renderView 导出 html 文件
     * - function 使用用户传入的函数自定义分析结果, 会传入 Module[]
     * - json 将分析结果放到 json 文件中
     * [调用时机]
     * 单次构建任务, 生成完所有的 chunk 和资源后, 调用一次
     * 多入口项目, 仍然是调用一次
     */
    async closeBundle() {
      if (typeof opts.analyzerMode === 'function') {
        opts.analyzerMode(analyzerModule.processModule())
        return
      }

      if (opts.summary && !hasViteReporter) {
        logger.info(generateSummaryMessage(analyzerModule.modules))
      }
      const analyzeModule = analyzerModule.processModule()
      callCount++

      // 对于设置 'json' 和 'static' 的情况
      if (preferSilent) {
        const output = 'fileName' in opts ? opts.fileName : 'stats'
        let p = path.join(defaultWd, `${output}.${opts.analyzerMode === 'json' ? 'json' : 'html'}`)
        if (fs.existsSync(p)) {
          p = path.join(defaultWd, `${output}-${callCount}.${opts.analyzerMode === 'json' ? 'json' : 'html'}`)
        }
        if (opts.analyzerMode === 'json') {
          return fsp.writeFile(p, JSON.stringify(analyzeModule, null, 2), 'utf8')
        }
        const html = await renderView(analyzeModule, { title: reportTitle, mode: opts.defaultSizes || 'stat' })
        await fsp.writeFile(p, html, 'utf8')
        b.into(html)
        if (opts.analyzerMode === 'static' && !opts.openAnalyzer) {
          return
        }
      }

      // 对于设置 'server' 的情况
      if (preferLivingServer) {
        callCount--
        const html = await renderView(analyzeModule, { title: reportTitle, mode: opts.defaultSizes || 'stat' })
        b.into(html)
        // 获取可用的端口
        const port = await ensureEmptyPort(
          'analyzerPort' in opts
            ? opts.analyzerPort === 'auto'
              ? 0
              : (opts.analyzerPort || 0)
            : 8888 + callCount
        )
        const server = createServer()
        server.get('/', (c) => {
          c.res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf8;',
            'content-Encoding': 'gzip'
          })
          /**
           * zlib.createGzip() 用于创建 gzip 压缩流, 返回一个 可转换流
           * 将可读流中的数据通过 gzip 压缩后, 传入到 c.res 中
           */
          b.rs.pipe(zlib.createGzip()).pipe(c.res)
          b.refresh()
        })

        server.listen(port, () => {
          console.log('server run on ', ansis.hex('#5B45DE')(`http://localhost:${port}`))
        })
        if (('openAnalyzer' in opts ? opts.openAnalyzer : true) && !isCI) {
          const address = `http://localhost:${port}`
          openBrowser(address)
        }
        callCount++
      }
    }
  }

  return plugin
}

export { analyzer }
export { adapter } from './adapter'
export { analyzer as default }
export type { AnalyzerMode, AnalyzerPluginInternalAPI, AnalyzerPluginOptions, DefaultSizes, Module } from './interface'
export * from './render'
