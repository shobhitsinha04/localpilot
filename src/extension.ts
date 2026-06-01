import * as vscode from "vscode";

// Phase 0 — Project Setup (PHASES.md).
//
// This is the hello-world entry point. Its only job right now is to prove the
// full toolchain works: esbuild bundles it, VS Code loads it on F5, and the
// command shows a notification. No LocalPilot features exist yet — hardware
// detection, Ollama, indexing, chat, and completions arrive in Phase 1+.

export function activate(context: vscode.ExtensionContext): void {
  const helloWorld = vscode.commands.registerCommand(
    "localpilot.helloWorld",
    () => {
      vscode.window.showInformationMessage("Hello World from LocalPilot!");
    },
  );

  context.subscriptions.push(helloWorld);

  // Run the command once on activation so pressing F5 surfaces the notification
  // immediately, satisfying the Phase 0 verification step in PHASES.md.
  vscode.commands.executeCommand("localpilot.helloWorld");
}

export function deactivate(): void {
  // No resources to clean up in Phase 0. Later phases will stop the Ollama
  // daemon and Helicone proxy child processes here.
}
