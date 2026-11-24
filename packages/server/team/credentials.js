import { ERROR_CODES, teamError } from './errors.js'

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/

function textBytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

export function normalizeUsername(value) {
  if (typeof value !== 'string') {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '登录名必须是字符串')
  }
  const username = value.trim()
  if (!USERNAME_PATTERN.test(username)) {
    throw teamError(
      400,
      ERROR_CODES.INVALID_INPUT,
      '登录名必须是 3 到 64 位 ASCII 字母、数字、点、下划线或中划线',
    )
  }
  return {
    username: username.toLowerCase(),
    usernameKey: username.toLowerCase(),
  }
}

export function validatePassword(password) {
  if (typeof password !== 'string') {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '密码必须是字符串')
  }
  if (Array.from(password).length < 6) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '密码至少需要 6 个字符')
  }
  if (textBytes(password) > 1024) {
    throw teamError(400, ERROR_CODES.INVALID_INPUT, '密码不能超过 1024 字节')
  }
  return password
}
