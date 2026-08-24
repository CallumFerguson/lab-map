import type { Metadata } from 'next';
import './globals.css';

const title = 'SF Zoning Atlas';
const description =
  'Explore current San Francisco zoning use districts on an interactive MapLibre map using official DataSF boundaries.';

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
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
