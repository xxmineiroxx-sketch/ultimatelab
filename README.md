# Ultimatelabs Website

Modern landing page for Ultimatelabs - the ultimate music production ecosystem.

## Features

- Built with Next.js 14 and TypeScript
- Styled with Tailwind CSS
- Framer Motion for smooth animations
- Fully responsive design
- Optimized for Cloudflare Pages

## Getting Started

1. Install dependencies:
```bash
npm install
```

2. Run development server:
```bash
npm run dev
```

3. Build for production:
```bash
npm run build
```

## Deployment to Cloudflare Pages

1. Push this repository to GitHub
2. Connect your repository to Cloudflare Pages
3. Configure build settings:
   - Framework preset: Next.js
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Add your custom domain
5. Deploy!

## Project Structure

```
├── app/                    # Next.js app directory
│   ├── globals.css        # Global styles
│   ├── layout.tsx         # Root layout
│   └── page.tsx           # Home page
├── components/            # React components
│   ├── Hero.tsx
│   ├── AppShowcase.tsx
│   ├── Features.tsx
│   └── Footer.tsx
├── public/               # Static assets
└── package.json
```

## Customization

- Update app information in `components/AppShowcase.tsx`
- Modify colors in `tailwind.config.ts`
- Add your logo to the `public/` directory
- Update metadata in `app/layout.tsx`