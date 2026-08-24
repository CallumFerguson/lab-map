import type { Metadata } from 'next';
import './globals.css';

const title = 'SF Bio Lab Site Finder';
const description =
  'Screen San Francisco locations for an automated human iPSC research laboratory using official zoning boundaries and tailored parcel guidance.';
const socialImage =
  'https://sf-zoning-atlas.coolcorps.chatgpt.site/og.png';

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    type: 'website',
    images: [
      {
        url: socialImage,
        width: 1200,
        height: 630,
        alt: 'SF Bio Lab Site Finder map preview.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
    images: [socialImage],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
