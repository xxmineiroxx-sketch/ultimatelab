# Deploying to ultimatelab.co

Since your domain is already set up in Cloudflare, deployment is straightforward!

## Quick Deploy (2 minutes)

### Option 1: If using GitHub integration

```bash
# From the ultimatelabs-website directory
git init
git add .
git commit -m "Initial deploy for ultimatelab.co"
git remote add origin YOUR_GITHUB_REPO_URL
git branch -M main
git push -u origin main
```

Cloudflare Pages will automatically build and deploy from the main branch.

### Option 2: Manual deployment via Wrangler

```bash
# Install wrangler if you don't have it
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Deploy
wrangler pages deploy dist --project-name=ultimatelab --branch=main
```

### Option 3: Upload via Cloudflare Dashboard

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages** → **ultimatelab** project
3. Click **Create deployment**
4. Upload the contents of the `dist` folder
5. Deploy!

## Domain Configuration

Since your domain is already configured:

- ✅ DNS records should already point to Cloudflare Pages
- ✅ SSL certificate will be automatically provisioned
- ✅ Your site will be available at `https://ultimatelab.co`

## Verify Deployment

After deployment:

1. **Check the build**: Make sure there are no errors in the Cloudflare Pages build log
2. **Test the domain**: Visit `https://ultimatelab.co`
3. **Test all pages**: Click through navigation, apps, features
4. **Mobile check**: Test on your phone to ensure responsiveness

## Troubleshooting

### If you see "Build failed"
- Check Node.js version (needs 18+)
- Verify all dependencies installed: `npm install`
- Check build logs in Cloudflare dashboard

### If domain doesn't work
- Verify DNS records in Cloudflare DNS tab
- Ensure CNAME points to your Pages project
- Wait 5-10 minutes for DNS propagation

### SSL issues
- Cloudflare provides free SSL automatically
- Set SSL/TLS mode to "Full (Strict)" in SSL/TLS settings

## Making Updates

For future updates:

```bash
# Make your changes
git add .
git commit -m "Update description"
git push origin main

# Cloudflare will auto-deploy!
```

## Build Output

Your built site is in `/Users/studio/ultimatelabs-website/dist/`:
- `index.html` - Homepage
- `404.html` - Error page
- `_next/` - Next.js assets

## Need Help?

- Check Cloudflare Pages docs: https://developers.cloudflare.com/pages
- Next.js static export: https://nextjs.org/docs/app/building-your-application/deploying/static-exports
- Run `./deploy.sh` for interactive deployment options

## Status: ✅ Ready to Deploy

Your site is built and ready for ultimatelab.co!

Next action: Choose deployment method above and launch! 🚀