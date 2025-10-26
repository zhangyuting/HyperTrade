# Setup Guide - Environment Configuration

## What Changed?

Your HyperSync API token has been moved from hardcoded values in the source code to a secure environment configuration file.

## Files Created/Modified

### ✅ Created Files:
1. **`.env`** - Contains your actual HyperSync token (NOT committed to git)
2. **`.env.example`** - Template file showing required environment variables (committed to git)

### ✅ Modified Files:
1. **`.gitignore`** - Updated to ignore `.env` and other sensitive files
2. **`package.json`** - Added `dotenv` dependency and npm scripts
3. **`smart_wallets_tui.js`** - Now reads token from environment variables
4. **`smart_wallets.js`** - Now reads token from environment variables
5. **`README.md`** - Updated with environment setup instructions

## Security Benefits

✅ **API token is now secure** - Not exposed in source code  
✅ **Git-safe** - `.env` file is automatically ignored by git  
✅ **Team-friendly** - New developers use `.env.example` as template  
✅ **Best practice** - Follows 12-factor app methodology  

## Quick Start

### For First-Time Setup:
```bash
# 1. Copy the example file
cp .env.example .env

# 2. Edit .env and add your token
# HYPERSYNC_BEARER=your-actual-token-here

# 3. Run the application
pnpm start
```

### Verifying Configuration:
```bash
# Check that .env exists but is ignored by git
ls -la .env          # Should exist
git status           # Should NOT show .env

# Check that .env.example is tracked
git status           # Should show .env.example (if new)
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `HYPERSYNC_URL` | HyperSync API endpoint | Yes (has default) |
| `HYPERSYNC_BEARER` | Your HyperSync API token | **Yes** |

## Getting a HyperSync Token

1. Visit [https://envio.dev](https://envio.dev)
2. Sign up for a free account
3. Generate an API token
4. Add it to your `.env` file

## Troubleshooting

### Error: "HYPERSYNC_BEARER token not found"
- Make sure `.env` file exists in the project root
- Check that `HYPERSYNC_BEARER` is set in `.env`
- Verify there are no typos in the variable name

### Token Still in Git History
If you accidentally committed the token before:
```bash
# Remove the token from git history (use with caution)
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch smart_wallets_tui.js smart_wallets.js" \
  --prune-empty --tag-name-filter cat -- --all

# Or simply rotate the token at https://envio.dev
```

### Testing the Setup
```bash
# Run the simple version first to test
pnpm run simple

# If that works, run the TUI version
pnpm start
```

## File Structure

```
HyperTrade/
├── .env                    # Your secrets (NEVER commit)
├── .env.example            # Template (commit this)
├── .gitignore              # Ensures .env is ignored
├── smart_wallets_tui.js    # Main TUI app
├── smart_wallets.js        # Simple console app
├── package.json            # Dependencies
└── README.md               # Main documentation
```

## What's Protected Now

The following files are automatically ignored by git:
- `.env` - Environment variables with secrets
- `account_state.json` - Trading account state
- `debug.log` - Debug output logs (when enableDebugLog is true)
- `hypersync_errors.log` - HyperSync client errors and stderr logs
- `.DS_Store` - macOS system files

## npm Scripts Available

```bash
pnpm start        # Run TUI version (smart_wallets_tui.js)
pnpm run simple   # Run simple console version (smart_wallets.js)
```

---

**Need Help?** Check the main README.md or open an issue.

