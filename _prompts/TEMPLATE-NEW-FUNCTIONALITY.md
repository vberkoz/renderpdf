# TEMPLATE: NEW FUNCTIONALITY - IDEMPOTENT
**Reference:** [Previous module that this builds on]

**AI Context:** [Specific technologies, libraries, patterns to focus on]
**Focus:** [Key constraints or approaches to emphasize]

## Reasoning
[Why this functionality is needed]:
- **Business value**: [What problem it solves]
- **Technical rationale**: [Why this approach vs alternatives]
- **Integration points**: [How it fits with existing system]

[Implementation considerations]:
- **Performance**: [Speed/memory/cost implications]
- **Security**: [Auth, data protection, validation needs]
- **Scalability**: [How it handles growth]
- **Maintainability**: [Code organization, testing]

[Decision logic]:
- If [condition]: [Action and reasoning]
- If [condition]: [Alternative action and reasoning]
- Always: [Non-negotiable requirements]

## State Detection
- Check if [existing components/files]
- Verify [current functionality works]
- Test [integration points]
- Validate [configuration/settings]

## Tasks (Conditional)
1. **If missing**: [Create new functionality]
2. **If exists**: [Update/enhance existing]
3. **If broken**: [Fix specific issues]
4. **Always**: [Required actions regardless of state]

## Verification
```bash
[Commands to test the functionality]
```

## Success Criteria
- [Measurable outcomes]
- [Integration requirements]
- [Performance benchmarks]

---

# EXAMPLE: RATE LIMITING - IDEMPOTENT
**Reference:** 07-AUTH-LAMBDA.md

**AI Context:** DynamoDB TTL, Lambda authorizer caching, API Gateway throttling
**Focus:** Cost-effective rate limiting without external dependencies

## Reasoning
Rate limiting prevents abuse and controls costs:
- **API protection**: Prevent excessive PDF generation
- **Cost control**: Limit AWS resource consumption per user
- **Fair usage**: Ensure service availability for all users
- **Security**: Mitigate DoS attacks

Implementation approach:
- **DynamoDB-based**: Use existing table with TTL for request counting
- **Authorizer integration**: Check limits during API key validation
- **Graceful degradation**: Clear error messages when limits exceeded
- **Configurable limits**: Different tiers for different users

Decision logic:
- If rate limiting missing: Add to authorizer function
- If limits too restrictive: Adjust based on usage patterns
- If bypassed: Fix validation logic
- Always: Return proper HTTP 429 responses

## State Detection
- Check if authorizer includes rate limiting logic
- Verify DynamoDB table has TTL configured
- Test rate limit enforcement
- Validate error responses

## Tasks (Conditional)
1. **If missing**: Add rate limiting to Lambda authorizer
   - Update DynamoDB table schema for request tracking
   - Implement sliding window algorithm
   - Configure TTL for automatic cleanup
2. **If exists**: Verify limits are appropriate
3. **If broken**: Fix counting logic or TTL configuration
4. **Always**: Test with burst requests to verify enforcement

## Verification
```bash
# Test rate limiting
for i in {1..20}; do
  curl -H "x-api-key: test-key" $API_URL/generate
done
# Should see 429 responses after limit reached
```

## Success Criteria
- Rate limits enforced per API key
- Proper 429 responses with retry-after headers
- Automatic reset after time window
- No impact on legitimate usage patterns