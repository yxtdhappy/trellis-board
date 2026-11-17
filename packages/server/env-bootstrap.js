import { loadProjectEnv } from './env-file.js'

// config.js 在 import 时求值 dataDir 等路径；入口必须把本模块放在第一个 import，.env 才先于配置生效。
loadProjectEnv()
