"use strict"

/**
 * 云函数：page_visit_counter
 * 作用：统计 H5 静态页访问次数（同一 user_id 每次调用 count + 1）
 *
 * 数据库：CloudBase MySQL（通过 Data Model OpenAPI 的 mysqlCommand 接口执行 SQL）
 * 认证：ApiKey（放在云函数环境变量 CLOUDBASE_APIKEY，不在代码里写死）
 *
 * 依赖前提：
 * - 你在 MySQL 表上给 user_id 建了唯一索引，才能实现 upsert 自增：
 *   UNIQUE KEY uk_user_id (user_id)
 *
 * 环境变量（云函数里配置）：
 * - CLOUDBASE_ENV_ID=xxxx（你的环境 ID）
 * - CLOUDBASE_APIKEY=xxxx（控制台创建的 ApiKey）
 *
 * 说明：
 * - 这里不需要 MySQL 的账号/密码（通过 CloudBase 提供的 API 执行 SQL）
 * - 调用失败不建议抛出到前端，可在前端忽略统计失败
 */

const https = require("https")
const tcb = require("@cloudbase/node-sdk")

const TABLE = "page_visit_count" // 你的表名（如不同请修改）

function httpPostJson(url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const body = JSON.stringify(bodyObj || {})

    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let chunks = ""
        res.setEncoding("utf8")
        res.on("data", (d) => (chunks += d))
        res.on("end", () => {
          let json = null
          try {
            json = chunks ? JSON.parse(chunks) : null
          } catch {
            // ignore
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, data: json })
          } else {
            const msg = json?.message || chunks || `HTTP ${res.statusCode}`
            reject(new Error(msg))
          }
        })
      }
    )

    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

async function getCallerIdentity() {
  // 对 H5 匿名登录：openId 可能为空；uid 通常可用
  try {
    const app = tcb.init({ env: tcb.SYMBOL_DEFAULT_ENV })
    const userInfo = await app.auth().getUserInfo()
    return {
      openId: userInfo?.openId || null,
      uid: userInfo?.uid || null,
    }
  } catch {
    return { openId: null, uid: null }
  }
}

exports.main = async (event) => {
  const envId = process.env.CLOUDBASE_ENV_ID || ""
  const apiKey = process.env.CLOUDBASE_APIKEY || ""

  const userId = String(event?.user_id || "").trim()
  if (!userId) return { ok: false, message: "缺少参数 user_id" }

  if (!envId) return { ok: false, message: "缺少环境变量 CLOUDBASE_ENV_ID" }
  if (!apiKey) return { ok: false, message: "缺少环境变量 CLOUDBASE_APIKEY" }

  const ident = await getCallerIdentity()
  const openid = ident.openId || ident.uid || null

  // mysqlCommand：通过 API Key（Bearer）执行 SQL
  // 文档：https://docs.cloudbase.net/en/http-api/model/mysql-command
  const url = `https://${envId}.api.tcloudbasegateway.com/v1/model/plugin/prod/mysqlCommand`

  // 使用 ON DUPLICATE KEY UPDATE 原子自增
  const sqlTemplate = `
INSERT INTO \`${TABLE}\` (createAt, _openid, user_id, count)
VALUES (NOW(), {{ _openid }}, {{ user_id }}, 1)
ON DUPLICATE KEY UPDATE
  count = count + 1,
  _openid = COALESCE(VALUES(_openid), _openid);
`.trim()

  try {
    const res = await httpPostJson(
      url,
      {
        Authorization: `Bearer ${apiKey}`,
      },
      {
        sqlTemplate,
        parameter: [
          { key: "_openid", type: "STRING", value: openid || "" },
          { key: "user_id", type: "STRING", value: userId },
        ],
        config: {
          timeout: 5,
          preparedStatements: true,
        },
      }
    )

    return { ok: true, data: res.data }
  } catch (e) {
    return { ok: false, message: e?.message || "mysqlCommand 调用失败" }
  }
}

