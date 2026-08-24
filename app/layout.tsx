import type { Metadata } from 'next';
import './globals.css';

const title = 'SF Zoning Atlas';
const description =
  'Explore current San Francisco zoning use districts on an interactive MapLibre map using official DataSF boundaries.';
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
        alt: 'SF Zoning Atlas — Read the city, parcel by parcel.',
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
