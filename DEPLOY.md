# Deploying Ultimatelabs to Cloudflare Pages

This guide will walk you through deploying your Ultimatelabs website to Cloudflare Pages with a custom domain.

## Prerequisites

- Node.js 18+ installed
- Git repository (GitHub, GitLab, or Bitbucket)
- Cloudflare account
- Domain name (optional, but recommended)

## Step 1: Initialize Git Repository

If you haven't already, initialize a git repository:

```bash
cd /Users/studio/ultimatelabs-website
git init
git add .
git commit -m "Initial commit: Ultimatelabs website"
```

Push to your GitHub/GitLab repository:

```bash
git remote add origin https://github.com/yourusername/ultimatelabs.git
git branch -M main
git push -u origin main
```

## Step 2: Set Up Cloudflare Pages

1. **Log in to Cloudflare Dashboard**
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com)

2. **Connect Your Repository**
   - Click "Workers & Pages" in the sidebar
   - Click "Create application" → "Pages" → "Connect to Git"
   - Select your git provider and authorize Cloudflare
   - Choose your ultimatelabs repository

3. **Configure Build Settings**
   - Framework preset: `Next.js`
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Click "Save and Deploy"

4. **Wait for Deployment**
   - Cloudflare will build and deploy your site
   - You'll get a temporary URL: `https://your-project.pages.dev`

## Step 3: Add Custom Domain (Optional)

If you have a domain:

1. **In Cloudflare Pages Settings:**
   - Go to "Custom domains" tab
   - Click "Set up a custom domain"
   - Enter your domain (e.g., `ultimatelabs.com`)

2. **Configure DNS:**
   - If your domain is already on Cloudflare: DNS records will be added automatically
   - If not: Follow the instructions to add the CNAME record

3. **SSL/TLS:**
   - Cloudflare provides free SSL certificates automatically
   - Your site will be available at `https://yourdomain.com`

## Step 4: Verify Deployment

- Visit your deployed site
- Check that all pages load correctly
- Test navigation and interactive elements
- Verify contact forms (if any)

## Troubleshooting

### Build Fails
- Ensure all dependencies are listed in `package.json`
- Check Node.js version compatibility
- Review build logs in Cloudflare dashboard

### Custom Domain Issues
- Verify DNS propagation with `dig yourdomain.com`
- Ensure SSL/TLS is set to "Full (Strict)"
- Check for conflicting DNS records

### Performance
- Images should be optimized before deployment
- Enable Cloudflare's Auto Minify feature
- Consider using Cloudflare Images for better performance

## Continuous Deployment

Your site will automatically deploy whenever you push to your main branch:

```bash
git add .
git commit -m "Update website content"
git push origin main
```

Cloudflare Pages will build and deploy the changes automatically.

## Additional Configuration

### Environment Variables
If you need environment variables:
1. Go to Pages project → Settings → Environment variables
2. Add variables for production environment

### Custom Headers
Edit `next.config.js` to add custom headers if needed.

### Analytics
Enable Cloudflare Web Analytics for visitor insights.

## Support

For Cloudflare Pages support: [Cloudflare Community](https://community.cloudflare.com/c/developers/cloudflare-pages/43)

For Next.js issues: [Next.js Documentation](https://nextjs.org/docs)