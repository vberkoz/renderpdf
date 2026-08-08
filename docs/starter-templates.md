# Starter Templates

The API bundles four HTML starter definitions in
`/Users/basilsergius/projects/renderpdf/api/starter_templates.go`. Copy one
into `POST /api/v1/templates` to create a customer-owned editable template.
Values always use `{{path.to.value}}` and are HTML escaped.

| Template | Documented variable groups |
| --- | --- |
| Invoice | `invoice.*`, `customer.*` |
| Contract | `contract.*`, `party.one.*`, `party.two.*` |
| Certificate | `certificate.*`, `recipient.*` |
| Receipt | `merchant.*`, `receipt.*`, `customer.*` |

## Exact variable schemas

### Invoice

- <code>invoice.number</code>, <code>invoice.issueDate</code>, <code>invoice.dueDate</code>
- <code>invoice.description</code>, <code>invoice.total</code>
- <code>customer.name</code>, <code>customer.address</code>

### Contract

- <code>contract.title</code>, <code>contract.date</code>, <code>contract.scope</code>
- <code>contract.startDate</code>, <code>contract.endDate</code>, <code>contract.paymentTerms</code>
- <code>party.one.name</code>, <code>party.two.name</code>

### Certificate

- <code>certificate.title</code>, <code>certificate.achievement</code>, <code>certificate.date</code>, <code>certificate.number</code>
- <code>recipient.name</code>

### Receipt

- <code>merchant.name</code>, <code>merchant.address</code>
- <code>receipt.number</code>, <code>receipt.date</code>, <code>receipt.description</code>, <code>receipt.amount</code>, <code>receipt.total</code>
- <code>customer.name</code>

## Migration from full HTML requests

1. Start with existing HTML sent to <code>POST /render</code>, or copy a bundled starter from <code>GET /api/v1/templates</code>.
2. Replace dynamic text with exact placeholders such as <code>{{customer.name}}</code>.
3. Create it with <code>POST /api/v1/templates</code> and retain its returned <code>id</code>.
4. Send <code>templateId</code> and matching nested <code>variables</code> to <code>POST /api/v1/render-template</code>.
5. Treat <code>422</code> as a variable-contract error: every placeholder must be present and no additional leaf values are allowed.

Each bundled definition includes representative data in source and is unit-tested before it is offered to clients.
