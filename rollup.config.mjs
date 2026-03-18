import terser from "@rollup/plugin-terser";
import webWorkerLoader from "rollup-plugin-web-worker-loader";
import { string } from "rollup-plugin-string";

export default {
  input: "public/entry.js",
  plugins: [
    webWorkerLoader({
      targetPlatform: "base64",
    }),
    string({
      include: ["**/*.css", "**/*.html"],
    }),
  ],
  output: [
    {
      file: "public/dist/agm.js",
      format: "es",
    },
    {
      file: "public/dist/agm.min.js",
      format: "es",
      plugins: [terser()],
    },
  ],
};
