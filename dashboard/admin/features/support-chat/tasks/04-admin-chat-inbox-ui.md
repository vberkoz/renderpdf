# Task 4: Admin Live Chat & Support Inbox UI

| Field | Value |
| :--- | :--- |
| **Task ID** | TASK-CHAT-04 |
| **Feature** | [`features/support-chat/`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/support-chat/spec.md) |
| **Status** | Completed |
| **Target Files** | `dashboard/admin/index.html`, `dashboard/admin/admin.js`, `dashboard/admin/admin.css`, `dashboard/admin/features/support-chat/chat.js` |
| **Prerequisites** | [`TASK-CHAT-02`](file:///Users/basilsergius/projects/renderpdf/dashboard/admin/features/support-chat/tasks/02-escalation-and-ses-alerts.md) |

---

## 1. Objective

Integrate **Tab 5: Live Chat & Support Inbox** (`#chats`) into the RenderPDF Admin Console (`/app/admin`), allowing operators to view all conversations, inspect visitor dossiers, and respond directly with optional email dispatch.

---

## 2. Technical Requirements

### 2.1 Navigation & Tab Shell (`dashboard/admin/index.html`)
1. Add `<a id="tab-chats" class="admin-tab-button" href="#chats" role="tab">Live Chat <span id="escalated-chats-badge" class="admin-badge-count hidden">0</span></a>` to secondary navigation.
2. Add `<section id="view-chats" class="admin-tab-view" role="tabpanel">` shell container.

### 2.2 Split-Pane Inbox Layout (`dashboard/admin/features/support-chat/chat.js`)
1. **Left Column (Conversation Queue)**:
   - Search filter (email, UUID, text).
   - Filter chips: `All`, `Escalated` (red badge), `Active`, `Resolved`.
   - List rendering with card items:
     - Visitor identifier (email or anonymous IP / city).
     - Source tag (`landing` vs `dashboard`).
     - Last message snippet and timestamp.
     - Unread indicator dot.
     - Escalation tag (`Enterprise Lead`, `Bug Report`, `Billing`).
2. **Right Column (Conversation Workspace)**:
   - **Header Bar**:
     - Customer email / visitor ID.
     - Plan tier badge (`Starter`, `Pro`, `Anonymous`).
     - "Inspect User Dossier" button: deep-links to Tab 3 (`#users`) with dossier drawer automatically opened.
     - Status toggle (`Active` vs `Resolved`).
   - **Transcript Stream**:
     - Chronological message list.
     - Three distinct bubble styles:
       - **Visitor**: Slate background on the left.
       - **AI Assistant**: Neutral background with "Nova Micro" pill and token counter.
       - **Operator**: Emerald background on the right with "Operator" badge.
     - System events: Inline escalation banners (`⚠️ Escalated to Human Operator`).
   - **Operator Reply Bar**:
     - Multi-line textarea with keyboard shortcut (`Cmd+Enter` / `Ctrl+Enter` to send).
     - Canned response dropdown for common answers (documentation link, custom pricing scheduler).
     - Checkbox: `[x] Send copy to visitor's email via SES` (enabled if visitor email is present).
     - Action buttons: `Send Reply` and `Resolve Chat`.

### 2.3 Real-Time Updates & Polling
- When the Chats tab is active, poll `GET /api/v1/admin/chats` every 10 seconds to surface new incoming messages without manual page reload.
- Update top navigation unread badge dynamically when escalated chats arrive.

---

## 3. Verification & Acceptance Criteria

1. **DOM & Interaction Tests**:
   - Switching to `#chats` renders conversation list and active chat transcript.
   - Filtering by "Escalated" shows only escalated sessions with reason tags.
   - Clicking "Inspect User Dossier" opens the user's detailed profile drawer in the Users tab.
   - Sending an operator reply appends message to transcript and posts to backend.
   - Marking chat as "Resolved" moves it to resolved queue and clears active escalation counters.
