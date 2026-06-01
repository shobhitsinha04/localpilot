# UI_UX.md

## Philosophy

LocalPilot should feel like a tool made by people who care about craft.
Not a Cursor clone, not a generic VS Code panel. It respects VS Code's
native environment — using its theme colors, its fonts, its spacing — but
has enough personality to feel like its own product. Subtle, confident,
uncluttered.

The UI should never get in the way of coding. When it's not being used,
it should be almost invisible. When it is being used, it should be fast,
clear, and satisfying to interact with.

**Design principles:**
1. Respect the editor — never fight VS Code's visual language
2. Earn attention — only show UI elements when they're needed
3. Be honest — loading states, errors, and limitations are shown clearly
4. Feel fast — streaming, instant feedback, no unexplained waits

---

## Visual Language

### Colors
Never hardcode colors. Every color must use VS Code CSS variables so the
UI automatically adapts to any theme (dark, light, high contrast).

**Core variables to use:**
```css
--vscode-editor-background          /* main background */
--vscode-editor-foreground          /* primary text */
--vscode-sideBar-background         /* sidebar background */
--vscode-sideBar-foreground         /* sidebar text */
--vscode-input-background           /* input fields */
--vscode-input-foreground           /* input text */
--vscode-input-border               /* input borders */
--vscode-button-background          /* primary buttons */
--vscode-button-foreground          /* primary button text */
--vscode-button-hoverBackground     /* button hover */
--vscode-textLink-foreground        /* links, accents */
--vscode-textCodeBlock-background   /* code block backgrounds */
--vscode-diffEditor-insertedLineBackground   /* diff green */
--vscode-diffEditor-removedLineBackground    /* diff red */
```

**LocalPilot accent color:**
One custom color used sparingly — the LocalPilot brand accent.
Used on: the activity bar icon active state, the "ready" indicator dot,
the send button on focus.
Value: `#7C6AF7` (a muted purple — works on both dark and light themes)
CSS variable: `--localpilot-accent: #7C6AF7`

### Typography
Inherit everything from VS Code. Never set a custom font-family.
```css
font-family: var(--vscode-font-family);
font-size: var(--vscode-font-size);         /* typically 13px */
font-size: var(--vscode-editor-font-size);  /* for code blocks */
font-family: var(--vscode-editor-font-family); /* for code blocks */
```

### Spacing
Base unit: 8px. All spacing is multiples of 4px or 8px.
- Tight spacing (between related elements): 4px
- Standard spacing (between sections): 8px
- Comfortable spacing (padding inside containers): 12px or 16px

### Border Radius
- Input fields: 6px
- Message bubbles: 8px
- Buttons: 4px
- Code blocks: 6px

### Transitions
Subtle and fast. Nothing should feel sluggish.
- Hover states: 120ms ease
- Button active states: 80ms ease
- Message appear: 150ms ease-in (opacity + 4px translate up)

---

## Activity Bar Icon

A small icon in the VS Code activity bar (left edge). Clicking it opens
or closes the LocalPilot sidebar panel.

**Icon:** A simple geometric mark — a small circle with a subtle pulse
ring. The circle represents local/contained. The pulse suggests
intelligence without being cliché (no robot faces, no lightning bolts).

**States:**
- Default: muted foreground color, matches other activity bar icons
- Active (panel open): LocalPilot accent color (#7C6AF7)
- Processing (model generating): subtle animated pulse on the ring
- Error: VS Code warning color, no animation

---

## Sidebar Panel Layout

The panel fills the full height of the VS Code sidebar. Three fixed
regions from top to bottom:

```
┌────────────────────────────┐
│         HEADER             │  48px fixed height
├────────────────────────────┤
│                            │
│                            │
│      CONVERSATION          │  flex: 1, scrollable
│           AREA             │
│                            │
│                            │
├────────────────────────────┤
│         INPUT AREA         │  auto height, min 52px, max 160px
└────────────────────────────┘
```

### Header
Height: 48px. Horizontally padded 12px each side.

Left side:
- "LocalPilot" wordmark in slightly bolder weight than body text
- Below it: model name in small muted text
  e.g. "qwen2.5-coder:7b" in --vscode-descriptionForeground color

Right side (icon buttons, 28x28px hit targets):
- **New Chat icon** — a compose/pencil icon. Tooltip: "New Chat".
  Clicking clears the conversation with no confirmation dialog.
- **More icon** (post-v1 placeholder) — three dots, disabled in v1,
  shown at reduced opacity to signal future functionality

A 1px separator line below the header using --vscode-panel-border.

### Conversation Area
Scrollable. Padding: 12px horizontal, 8px vertical.
Newest messages at the bottom. Auto-scrolls to bottom on new content.
User can scroll up freely to read history — auto-scroll only resumes
when user is already at the bottom.

**Empty state (no messages yet):**
Centered vertically in the conversation area:
```
    ◉ LocalPilot

  Ask anything about your code.
  Type @codebase to search your project.

  [ Try: "Explain this file" ]
  [ Try: "How does auth work? @codebase" ]
```
The "Try" items are clickable — clicking populates the input field.
Subtle, not pushy. Disappears the moment the first message is sent.

### Input Area
Background: slightly different from conversation area to visually
separate it. Use --vscode-input-background.
Padding: 8px 12px.
A 1px top border using --vscode-panel-border.

**Text input:**
- Multi-line textarea, no hard border (borderless, background only)
- Placeholder: "Ask LocalPilot..."
- Grows vertically as user types, up to max height of 120px, then scrolls
- Font size matches VS Code editor font size
- No resize handle

**Below the textarea, right-aligned:**
- Character/token hint (post-v1, not in v1)
- **Send button:** only the send icon (arrow), no label. 28x28px.
  Enabled when input is non-empty and model is not generating.
  Accent color (#7C6AF7) when enabled, muted when disabled.
  Tooltip: "Send (Enter)"

**Keyboard behaviour:**
- Enter → send message
- Shift+Enter → new line in input
- Escape → cancel if model is generating, otherwise do nothing

**While model is generating:**
- Input field disabled (opacity 0.5, not interactable)
- Send button replaced with **Stop button** (square stop icon)
  in the same position. Clicking cancels the in-flight request.

---

## Message Bubbles

### User Messages
- Right-aligned
- Background: --vscode-input-background with slight opacity
- Border radius: 8px, with bottom-right corner squared (4px) —
  classic chat bubble direction indicator
- Padding: 8px 12px
- Max width: 85% of panel width
- Plain text only, no markdown rendering
- Small timestamp shown on hover (relative: "just now", "2m ago")

### Assistant Messages
- Left-aligned, no background (blends into conversation area)
- Full width (no max-width constraint)
- Padding: 4px 0 (breathing room between messages)
- Full markdown rendering:

  **Paragraphs:** standard line-height 1.6, comfortable reading
  
  **Code blocks:**
  - Background: --vscode-textCodeBlock-background
  - Border radius: 6px
  - Padding: 12px
  - Font: editor font family + size
  - Language label top-right in small muted text
  - Copy button top-right (appears on hover of code block):
    clipboard icon, clicking copies content, icon briefly changes
    to a checkmark for 1.5 seconds to confirm
  - Horizontal scroll for long lines, never wraps
  
  **Inline code:** background tinted, 2px horizontal padding,
  same border radius as code blocks but inline
  
  **Bold, italic, lists:** standard markdown rendering, nothing special

### Streaming State
While the model is generating, the assistant message bubble shows:
- Text streams in token by token, left to right
- A blinking cursor (|) at the end of the current text
- The cursor disappears when streaming ends
- No spinner, no "thinking..." placeholder — text appears immediately
  as the first token arrives

### Retrieval Chips (@codebase)
When @codebase is used, shown between the user message and the
assistant response:
```
  Searched codebase · 4 files
  [ auth.ts ] [ middleware.ts ] [ routes/user.ts ] [ types.ts ]
```
- Small muted text for "Searched codebase · N files"
- File names shown as small pill/chip elements
  Background: --vscode-badge-background
  Text: --vscode-badge-foreground
  Border radius: 4px, padding: 2px 6px
- Non-clickable in v1

### Error Messages
Shown inline in the conversation area, not as toast notifications.
```
  ⚠ LocalPilot isn't responding.
    [Restart]
```
- Warning icon + short plain-English message
- Actionable button where relevant
- Color: --vscode-editorWarning-foreground
- No red — red implies something the user did wrong. This is a system
  state, not a user error.

---

## CMD+K Input Box

Appears floating directly above the selected code block when CMD+K
is pressed.

**Appearance:**
- Full width of the editor (not just the selection width)
- Height: 36px fixed
- Background: --vscode-input-background
- Border: 1px solid --localpilot-accent (#7C6AF7) — the accent color
  here signals this is an AI-powered interaction
- Border radius: 6px
- Padding: 0 12px
- A small "✦ Edit" label on the left in muted text (4px right margin)
  followed by the text input
- Placeholder: "Describe your edit..."

**States:**
- Active (waiting for input): accent border, cursor blinking in input
- Submitted (generating): border becomes dashed, subtle pulse animation,
  input disabled
- Done (diff shown): input box disappears, replaced by diff view

**Positioning:**
Rendered as a VS Code editor decoration. Sits in the gutter area
directly above the first line of the selection. If the selection starts
at line 1 (no room above), it appears below the selection instead.

---

## Onboarding Screens

The onboarding flow runs inside the sidebar panel, replacing the normal
chat UI until complete. Each step is a full-panel view.

### General Onboarding Style
- Centered content vertically and horizontally within the panel
- No header bar during onboarding (replaced by step indicator)
- Step indicator: small dots at the top, one per step, current step
  filled with accent color
- Generous white space — this is a calm, reassuring flow, not rushed

### Step 0 — Welcome
```
        ◉ LocalPilot

   AI coding, entirely on your machine.
   Nothing you write ever leaves this computer.

   This setup takes 5–15 minutes.
   Most of that is a one-time model download.

        [ Get Started ]
```
- Logo mark centered, 32px
- Headline in slightly larger text (15px)
- Subtext in muted color
- Single large primary button, full width minus 24px padding each side

### Steps 1–5 — Progress Steps
```
  ● ● ○ ○ ○  (step indicator)

  Downloading Qwen2.5-Coder 7B

  [████████████░░░░░░░░] 48%
  2.3 GB of 4.7 GB · about 4 minutes remaining

  This is a one-time download. After this,
  everything works offline forever.
```
- Step title in standard weight, 14px
- Progress bar: full width minus 24px padding, height 6px
  Filled portion: accent color. Track: --vscode-input-background.
  Border radius: 3px (pill shaped)
- Status text below bar in muted small text
- Reassurance copy below that in muted small text — calm, human
- No buttons during active progress steps (nothing to click)

### Completed Sub-steps
```
  ✓ Ollama installed
  ✓ Chat model ready
  ↻ Downloading autocomplete model...
```
Checklist style. Completed items in muted foreground with accent
checkmark. Current item with a subtle spinner. Not yet started items
not shown (appear as they become relevant).

### Step 6 — Ready
```
  ✓ LocalPilot is ready

  Try it:
  · Pause while typing — autocomplete will appear
  · Ask a question below about your code
  · Use @codebase to search your whole project

        [ Start Coding ]
```
- Checkmark in accent color, slightly larger
- Tips in muted text, left-aligned within a centered container
- Single button dismisses onboarding and shows chat panel

### Error States During Onboarding
If a step fails, the progress view is replaced with:
```
  ✗ Couldn't install Ollama

  LocalPilot needs Ollama to run models locally.
  Please install it manually:

  [ Download Ollama ]   [ I've installed it → retry ]
```
- Error icon in warning color (not red)
- Plain English explanation of what failed and what to do
- Actionable buttons
- Never a raw error message or stack trace

---

## Diff View (CMD+K Accept/Reject)

Shown in the editor after CMD+K generates a rewrite.

**Removed lines (original):**
- Background: --vscode-diffEditor-removedLineBackground
- Left gutter: thin red bar (2px)
- Text: slightly muted (opacity 0.7)
- Prefix: "−" in gutter

**Added lines (new):**
- Background: --vscode-diffEditor-insertedLineBackground  
- Left gutter: thin green bar (2px)
- Text: full opacity
- Prefix: "+" in gutter

**Accept / Reject bar:**
Floats below the diff, right-aligned:
```
                    [ ✓ Accept  ⌘↩ ]  [ ✗ Reject  Esc ]
```
- Accept button: accent color background, white text
- Reject button: ghost style (border only, no fill)
- Keyboard shortcuts shown inside buttons
- Bar disappears after either action

---

## What Claude Code Should Never Do in the UI

- Hardcode any color values except --localpilot-accent
- Use any font other than VS Code's inherited fonts
- Add animations longer than 300ms
- Show raw error messages, stack traces, or technical jargon to users
- Add UI elements that are always visible but rarely useful
- Use toast/notification popups for anything that belongs inline
- Show a loading spinner where streaming text can appear instead
