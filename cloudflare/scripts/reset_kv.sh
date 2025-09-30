# 1) Create a new namespace (different title from the existing one)
npx -y wrangler@latest kv namespace create pages_kv_1
# -> Note the returned ID (call it NEW_ID)

# 2) Edit cloudflare/wrangler.toml and replace the [[kv_namespaces]] id with NEW_ID
#    Keep binding = "PAGES_KV" as-is

# 3) Redeploy so the Worker now binds to the new, empty KV
npx -y wrangler@latest deploy

# 4) Now that the Worker is no longer attached to the old namespace, delete the old one
npx -y wrangler@latest kv namespace delete --namespace-id <old_kv_id>
