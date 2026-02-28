#!/bin/bash

# Ultimatelab.co Deployment Script
# This script helps deploy the website to your existing Cloudflare Pages setup

echo "🚀 Deploying Ultimatelab.co to Cloudflare Pages..."

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Please run this script from the ultimatelabs-website directory."
    exit 1
fi

echo -e "${BLUE}📦 Building site...${NC}"
npm run build

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Build successful!${NC}"
else
    echo -e "❌ Build failed. Please fix errors before deploying."
    exit 1
fi

echo ""
echo -e "${BLUE}☁️  Cloudflare Pages Deployment Options:${NC}"
echo ""
echo "1. Direct Upload (wrangler)"
echo "2. GitHub Integration (recommended)"
echo "3. Manual deployment instructions"
echo ""
read -p "Select option (1-3): " option

case $option in
    1)
        echo -e "${BLUE}📤 Deploying via Wrangler...${NC}"
        if command -v wrangler &> /dev/null; then
            wrangler pages deploy dist --project-name=ultimatelab --branch=main
        else
            echo -e "${YELLOW}⚠️  Wrangler not found. Installing...${NC}"
            npm install -g wrangler
            wrangler pages deploy dist --project-name=ultimatelab --branch=main
        fi
        ;;
    2)
        echo -e "${BLUE}🔗 GitHub Integration${NC}"
        echo ""
        echo "To deploy via GitHub:"
        echo "1. Push this code to GitHub:"
        echo "   git add ."
        echo "   git commit -m 'Update website'"
        echo "   git push origin main"
        echo ""
        echo "2. Cloudflare Pages will auto-deploy from the main branch"
        echo "3. Your site will be available at https://ultimatelab.co"
        ;;
    3)
        echo -e "${BLUE}📋 Manual Deployment Steps:${NC}"
        echo ""
        echo "1. Go to https://dash.cloudflare.com"
        echo "2. Navigate to Workers & Pages → your ultimatelab project"
        echo "3. Click 'Create deployment' or wait for auto-deployment"
        echo "4. Ensure custom domain is set to: ultimatelab.co"
        echo "5. Build settings:"
        echo "   - Build command: npm run build"
        echo "   - Build output directory: dist"
        echo ""
        echo -e "${GREEN}✅ Your site is built and ready in the 'dist' folder${NC}"
        ;;
    *)
        echo "❌ Invalid option"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}🎉 Deployment process complete!${NC}"
echo ""
echo "Your website is ready for ultimatelab.co"
echo "Built files are in the 'dist' directory"
echo ""
echo "Quick links:"
echo "- Local preview: npm run dev"
echo "- Rebuild: npm run build"
echo "- Deployed site: https://ultimatelab.co"