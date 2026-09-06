/**
 * Atomic Lua transitions, one per algorithm.
 *
 * Each script runs inside Redis as a single atomic step so the
 * read-check-update sequence can never interleave across gateway instances.
 * Return value shape (array): { allowed(1/0), remaining, resetMs, retryAfterMs, limit }
 */

export const FIXED_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local windowStart = math.floor(now / windowMs) * windowMs
local resetMs = windowStart + windowMs
local storedStart = redis.call('HGET', KEYS[1], 'windowStart')
local count
if storedStart == false or tonumber(storedStart) ~= windowStart then
  count = 1
  redis.call('HSET', KEYS[1], 'count', count, 'windowStart', windowStart)
else
  count = redis.call('HINCRBY', KEYS[1], 'count', 1)
end
redis.call('PEXPIRE', KEYS[1], math.max(1, resetMs - now))
local allowed = 0
if count <= limit then allowed = 1 end
local remaining = math.max(0, limit - count)
local retry = 0
if allowed == 0 then retry = math.max(0, resetMs - now) end
return {allowed, remaining, resetMs, retry, limit}
`;

export const TOKEN_BUCKET_LUA = `
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local rate = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'lastRefill')
local tokensBefore = tonumber(data[1])
if tokensBefore == nil then tokensBefore = capacity end
local lastRefill = tonumber(data[2])
if lastRefill == nil then lastRefill = now end
local elapsed = math.max(0, (now - lastRefill) / 1000)
local refilled = math.min(capacity, tokensBefore + elapsed * rate)
local allowed = 0
if refilled >= 1 then allowed = 1 end
local tokensAfter = refilled
if allowed == 1 then tokensAfter = refilled - 1 end
redis.call('HSET', KEYS[1], 'tokens', tokensAfter, 'lastRefill', now)
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / rate) * 1000) + 1000)
local remaining = math.max(0, math.floor(tokensAfter))
local resetMs = now
local retry = 0
if allowed == 1 then
  if tokensAfter < capacity - 1e-9 then
    resetMs = now + math.ceil(((capacity - tokensAfter) / rate) * 1000)
  end
else
  retry = math.ceil(((1 - refilled) / rate) * 1000)
  resetMs = now + retry
end
return {allowed, remaining, resetMs, retry, capacity}
`;

export const SLIDING_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local curStart = math.floor(now / windowMs) * windowMs
local data = redis.call('HMGET', KEYS[1], 'currentCount', 'currentWindowStart', 'previousCount')
local cur = tonumber(data[1]) or 0
local storedStart = tonumber(data[2])
local prevCount = tonumber(data[3]) or 0
local currentCount = 0
local previousCount = 0
if storedStart ~= nil and storedStart == curStart then
  currentCount = cur
  previousCount = prevCount
elseif storedStart ~= nil and storedStart == curStart - windowMs then
  previousCount = cur
  currentCount = 0
end
local elapsed = now - curStart
local overlap = math.min(1, math.max(0, (windowMs - elapsed) / windowMs))
local estimate = previousCount * overlap + currentCount
local allowed = 0
if estimate < limit then allowed = 1 end
if allowed == 1 then currentCount = currentCount + 1 end
redis.call('HSET', KEYS[1], 'currentCount', currentCount, 'currentWindowStart', curStart, 'previousCount', previousCount)
redis.call('PEXPIRE', KEYS[1], windowMs * 2)
local resetMs = curStart + windowMs
local remaining = 0
local retry = 0
if allowed == 1 then
  remaining = math.max(0, limit - math.ceil(estimate) - 1)
else
  retry = math.max(0, resetMs - now)
end
return {allowed, remaining, resetMs, retry, limit}
`;

export const LEAKY_BUCKET_LUA = `
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local rate = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'level', 'lastLeak')
local prevLevel = tonumber(data[1]) or 0
local lastLeak = tonumber(data[2])
if lastLeak == nil then lastLeak = now end
local elapsed = math.max(0, (now - lastLeak) / 1000)
local drained = math.max(0, prevLevel - elapsed * rate)
local allowed = 0
if drained + 1 <= capacity + 1e-9 then allowed = 1 end
local level = drained
if allowed == 1 then level = drained + 1 end
redis.call('HSET', KEYS[1], 'level', level, 'lastLeak', now)
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / rate) * 1000) + 1000)
local remaining = math.max(0, capacity - math.ceil(level))
local retry = 0
if allowed == 0 then
  retry = math.ceil(((drained + 1 - capacity) / rate) * 1000)
end
local resetMs = now
if level > 0 then resetMs = now + math.ceil((level / rate) * 1000) end
return {allowed, remaining, resetMs, retry, capacity}
`;
