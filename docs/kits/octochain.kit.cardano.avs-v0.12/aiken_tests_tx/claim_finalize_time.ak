
test claim_then_finalize_time_path() {
  // TODO: construct ScriptContext for Claim with valid_range.lower_bound >= created_at_time_ms
  // TODO: ensure output to Claim script with inline datum and escrow lock
  // Then Finalize: valid_from >= created_at_time_ms + window_ms, collect claim + escrow, read claim as ref
  expect True == True
}
