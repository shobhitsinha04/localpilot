import { describe, expect, it } from "vitest";

import { parseWebviewMessage } from "../src/webviewProtocol";

describe("parseWebviewMessage", () => {
  it("accepts the no-payload messages", () => {
    expect(parseWebviewMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseWebviewMessage({ type: "stop" })).toEqual({ type: "stop" });
    expect(parseWebviewMessage({ type: "newChat" })).toEqual({
      type: "newChat",
    });
    expect(parseWebviewMessage({ type: "restart" })).toEqual({
      type: "restart",
    });
  });

  it("accepts sendMessage with non-empty text", () => {
    expect(parseWebviewMessage({ type: "sendMessage", text: "hi" })).toEqual({
      type: "sendMessage",
      text: "hi",
    });
  });

  it("rejects sendMessage with missing, non-string, or blank text", () => {
    expect(parseWebviewMessage({ type: "sendMessage" })).toBeNull();
    expect(parseWebviewMessage({ type: "sendMessage", text: 42 })).toBeNull();
    expect(
      parseWebviewMessage({ type: "sendMessage", text: "   " }),
    ).toBeNull();
  });

  it("rejects unknown types and non-object input", () => {
    expect(parseWebviewMessage({ type: "evil" })).toBeNull();
    expect(parseWebviewMessage(null)).toBeNull();
    expect(parseWebviewMessage("ready")).toBeNull();
    expect(parseWebviewMessage(undefined)).toBeNull();
  });
});
