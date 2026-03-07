// Symphony TypeScript - Workflow File Watcher (Section 6.2)
// Watches WORKFLOW.md for changes and triggers reload

import { watch, type FSWatcher } from "chokidar";
import { logger } from "./logger";

export class WorkflowWatcher {
  private watcher: FSWatcher | null = null;
  private onChange: () => void;
  private filePath: string;

  constructor(filePath: string, onChange: () => void) {
    this.filePath = filePath;
    this.onChange = onChange;
  }

  start(): void {
    this.watcher = watch(this.filePath, {
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on("change", () => {
      logger.info("WORKFLOW.md changed, reloading", { path: this.filePath });
      this.onChange();
    });

    this.watcher.on("error", (error) => {
      logger.warn("Workflow watcher error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
