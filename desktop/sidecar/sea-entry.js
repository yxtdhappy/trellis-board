import { runSidecarMain, SIDECAR_EXIT_CODE } from "./main.js";

runSidecarMain()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = SIDECAR_EXIT_CODE.IO;
  });
