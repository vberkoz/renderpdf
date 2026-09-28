# Task 3: Client Support Chat Widget

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-CHAT-03 |
| **Feature** | [`features/support-chat/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/support-chat/spec.md) |
| **Status** | Completed |
| **Target Files** | `landing/index.html`, `dashboard/index.html`, `dashboard/chat-widget.js`, `dashboard/chat-widget.css` |
| **Prerequisites** | [`TASK-CHAT-01`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/support-chat/tasks/01-bedrock-knowledge-and-chat-api.md) |

---

## 1. Objective

Build a zero-dependency, high-performance vanilla JavaScript and CSS chat widget (~6 KB) and embed it across the landing page and customer dashboard.

---

## 2. Technical Requirements

### 2.1 UI & Design System (`dashboard/chat-widget.js` & `dashboard/chat-widget.css`)
1. **Floating Trigger Button**:
   - Fixed to bottom-right corner (`bottom: 24px; right: 24px; z-index: 9999`).
   - Branded RenderPDF styling: dark circular launcher with emerald accent pulse, chat icon, and tooltip on hover.
2. **Chat Window**:
   - Responsive overlay (`380px` width on desktop, full-width bottom drawer on mobile `< 640px`).
   - Clean header with RenderPDF icon, status indicator ("AI Support · Usually replies in 1s"), and minimize/close button.
   - Message scroll container with smooth auto-scroll to bottom.
   - Formatted message bubbles:
     - Visitor message: Right-aligned, dark/accent background.
     - Bot message: Left-aligned, markdown support (code blocks, bold text, links).
   - Typing indicator dots while waiting for Bedrock response.
   - Composer with text input, send button, and quick suggestion chips ("Pricing", "API Docs", "Code Example").

### 2.2 Client State & Session Persistence
1. Store `renderpdf_chat_session_id` in `sessionStorage` to maintain conversation across page navigation.
2. If the user is on the dashboard ([`dashboard/app.js`](file:///Users/basilsergius/projects/renderpdf/dashboard/app.js)):
   - Automatically extract `email`, `sub`, and current plan from the active Cognito session.
   - Attach `visitorContext` to requests so the bot and operator have customer identity immediately.
3. If the bot flags `requiresEmail: true`, display an inline prompt: *"Leave your email so our engineering team can follow up with you"*.

### 2.3 Integration
1. Add script & styles to [`landing/index.html`](file:///Users/basilsergius/projects/renderpdf/landing/index.html) before `</body>`.
2. Add script & styles to [`dashboard/index.html`](file:///Users/basilsergius/projects/renderpdf/dashboard/index.html).
3. Ensure zero impact on Lighthouse / Core Web Vitals (load script deferred / async).

---

## 3. Verification & Acceptance Criteria

1. **Manual / DOM Test**:
   - Open landing page; click chat bubble; type "What are your starter plan limits?".
   - Verify reply renders within 1 second.
   - Verify code snippets and markdown format correctly.
   - Verify session persists when navigating between pages.
   - Open dashboard; verify customer email is passed in request payload.
