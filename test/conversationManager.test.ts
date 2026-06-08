import { describe, expect, it } from "vitest";

import { ConversationManager } from "../src/services/conversationManager";

describe("ConversationManager", () => {
  it("starts empty", () => {
    const cm = new ConversationManager();
    expect(cm.length).toBe(0);
    expect(cm.getHistory()).toEqual([]);
  });

  it("records user and assistant turns in order", () => {
    const cm = new ConversationManager();
    cm.addUser("hi");
    cm.addAssistant("hello");
    cm.addUser("bye");
    expect(cm.getHistory()).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ]);
    expect(cm.length).toBe(3);
  });

  it("returns a defensive copy that cannot mutate internal state", () => {
    const cm = new ConversationManager();
    cm.addUser("hi");
    const out = cm.getHistory();
    out.push({ role: "assistant", content: "injected" });
    out[0].content = "tampered";
    expect(cm.getHistory()).toEqual([{ role: "user", content: "hi" }]);
  });

  it("clear() empties the conversation", () => {
    const cm = new ConversationManager();
    cm.addUser("hi");
    cm.addAssistant("hello");
    cm.clear();
    expect(cm.length).toBe(0);
    expect(cm.getHistory()).toEqual([]);
  });
});
