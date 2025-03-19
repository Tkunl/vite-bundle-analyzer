import { writeFileSync } from 'fs'
import path from 'path'

/**
 * 保存对象/Map/Set 到唯一命名的 JSON 文件
 * @param data 要保存的数据 (对象/Map/Set)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function log2Text(data: object | Map<any, any> | Set<any>): void {
  // 1. 转换数据为 JSON 格式
  let jsonData: string

  if (data instanceof Map) {
    // 转换 Map 为可序列化的数组格式
    jsonData = JSON.stringify(Array.from(data.entries()), null, 2)
  } else if (data instanceof Set) {
    // 转换 Set 为数组
    jsonData = JSON.stringify(Array.from(data), null, 2)
  } else {
    // 普通对象直接序列化
    jsonData = JSON.stringify(data, null, 2)
  }

  // 2. 生成唯一文件名 (时间戳 + 随机数)
  const timestamp = Date.now()
  const random = Math.floor(Math.random() * 1000)
  const filename = `data_${timestamp}_${random}.txt`

  // 3. 获取保存路径
  const savePath = path.join(process.cwd(), filename)
  const absolutePath = path.resolve(savePath)

  // 4. 写入文件
  try {
    writeFileSync(absolutePath, jsonData, 'utf-8')
    console.log(`数据已保存至: ${absolutePath}`)
  } catch (err) {
    console.error('文件保存失败:', err)
  }
}
