import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@earendil-works/pi-coding-agent",
          "@earendil-works/pi-ai",
          "@earendil-works/pi-agent-core",
          "@earendil-works/pi-tui",
          "typebox",
        ],
      }),
    ],
    build: {
      outDir: "out/main",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/main.ts"),
        },
        external: [
          "electron",
        ],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/preload.ts"),
        },
      },
    },
  },
  renderer: {
    root: "src",
    build: {
      outDir: "out/renderer",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/index.html"),
        },
      },
    },
    plugins: [react()],
  },
});
