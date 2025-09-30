# Prereqs: brew install awscli
# Create an R2 API token in the Cloudflare Dashboard with permissions for the "pages" bucket (List, Read, Write, Delete)

export AWS_ACCESS_KEY_ID="d6d46bdf81722822e6481886dd2a5318"
export AWS_SECRET_ACCESS_KEY="021b7289d0ac94d35827ee4c9623e84629d2b4471d868291fe3c0e5aaca2eabf"
export AWS_DEFAULT_REGION="auto"   # required by awscli
ACCOUNT_ID="c0c9e680df1851ba1d32a850c6e74ec9"
ENDPOINT="https://${ACCOUNT_ID}.r2.cloudflarestorage.com"

# Recursively delete all objects (handles pagination + deletes quickly)
aws s3 rm s3://pages --recursive --endpoint-url "$ENDPOINT"

# Optionally remove and recreate the bucket in one shot
aws s3 rb s3://pages --force --endpoint-url "$ENDPOINT"
npx -y wrangler@latest r2 bucket create pages
