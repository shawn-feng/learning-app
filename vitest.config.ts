import { defineConfig } from "vitest/config";
import os from "os";
import path from "path";

// 测试数据隔离：让 electron 侧 getDataDir() 落到临时目录，而非真实 data/，
// 避免测试读写污染用户已保存的配置（如 app-settings.json 的编程模型配置）。
const testDataDir = path.join(os.tmpdir(), "pi-test-data");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 测试文件共享 PI_TEST_DATA_DIR（系统 tmp）：必须串行执行，
    // 否则多个文件的 beforeAll 清理会互相删掉对方正在使用的数据。
    fileParallelism: false,
    env: {
      PI_TEST_DATA_DIR: testDataDir,
    },
  },
});
