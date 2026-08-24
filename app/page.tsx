'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, {
  type FilterSpecification,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapMouseEvent,
  type Marker,
} from 'maplibre-gl';
import type { FeatureCollection, Geometry } from 'geojson';

const DATA_URL =
  'https://data.sfgov.org/resource/3i4a-hu95.geojson?$limit=20000';
const ADDRESS_API = 'https://data.sfgov.org/resource/3mea-di5p.json';

const INITIAL_VIEW = {
  center: [-122.438, 37.758] as [number, number],
  zoom: 11.55,
  bearing: 0,
  pitch: 0,
};

const ZONING_COLORS = [
  'match',
  ['get', 'gen'],
  'Residential',
  '#f1c75b',
  'Mixed Use',
  '#ef9562',
  'Mixed',
  '#ef9562',
  'Commercial',
  '#c27ad3',
  'Industrial',
  '#6d96a8',
  'Public',
  '#7ebf8d',
  '#a5a29b',
];

const CATEGORIES = [
  { label: 'All zones', value: 'all', color: '#f05a3c' },
  { label: 'Residential', value: 'Residential', color: '#f1c75b' },
  { label: 'Mixed use', value: 'Mixed Use', color: '#ef9562' },
  { label: 'Commercial', value: 'Commercial', color: '#c27ad3' },
  { label: 'Industrial', value: 'Industrial', color: '#6d96a8' },
  { label: 'Public', value: 'Public', color: '#7ebf8d' },
] as const;

const LAB_PROFILES = [
  {
    value: 'dry',
    label: 'Dry / computational',
    shortLabel: 'Dry lab',
    detail: 'Computing, instruments, or office-like R&D with little wet work.',
  },
  {
    value: 'standard',
    label: 'Analytical laboratory',
    shortLabel: 'Standard lab',
    detail: 'Chemistry, engineering, development, testing, or support lab.',
  },
  {
    value: 'life_science',
    label: 'Life-science wet lab',
    shortLabel: 'Life science',
    detail: 'Biological R&D tied to products or services; a distinct SF use.',
  },
  {
    value: 'pilot',
    label: 'Pilot production',
    shortLabel: 'Pilot production',
    detail: 'Research plus small-batch processing or manufacturing.',
  },
] as const;

type ExplorerMode = 'zoning' | 'lab';
type CategoryValue = (typeof CATEGORIES)[number]['value'];
type LabProfile = (typeof LAB_PROFILES)[number]['value'];
type LabNeed = 'hazmat' | 'gases' | 'animals' | 'clinical';
type FitTone = 'lead' | 'review' | 'low';
type ZoningLoadPhase = 'connecting' | 'downloading' | 'parsing' | 'rendering' | 'ready';

type ZoningLoadState = {
  phase: ZoningLoadPhase;
  loadedBytes: number;
  totalBytes: number | null;
  featureCount: number | null;
};

type ZoneDetails = {
  zoning: string;
  name: string;
  category: string;
  codeSection?: string;
  codeUrl?: string;
};

type AddressResult = {
  address: string;
  longitude: string;
  latitude: string;
  parcel_number?: string;
};

type LabAssessment = {
  tone: FitTone;
  label: string;
  reason: string;
};

const FIT_META: Record<FitTone, { label: string; color: string }> = {
  lead: { label: 'Better starting lead', color: '#2d9a82' },
  review: { label: 'Needs zoning review', color: '#d68a2f' },
  low: { label: 'Lower-fit signal', color: '#8b8f8b' },
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadZoningData(
  signal: AbortSignal,
  onProgress: (loadedBytes: number, totalBytes: number | null) => void,
  onParsing: () => void,
): Promise<FeatureCollection<Geometry>> {
  const response = await fetch(DATA_URL, { signal });
  if (!response.ok) throw new Error(`Zoning download failed (${response.status})`);

  const contentLength = Number(response.headers.get('content-length'));
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0
    ? contentLength
    : null;

  if (!response.body) {
    const text = await response.text();
    onProgress(new TextEncoder().encode(text).byteLength, totalBytes);
    onParsing();
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    return JSON.parse(text) as FeatureCollection<Geometry>;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loadedBytes += value.byteLength;
    onProgress(loadedBytes, totalBytes);
  }

  const joined = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  onParsing();
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  return JSON.parse(new TextDecoder().decode(joined)) as FeatureCollection<Geometry>;
}

function getZoneDetails(properties: Record<string, unknown>): ZoneDetails {
  return {
    zoning: String(properties.zoning_sim ?? properties.zoning ?? 'Unknown'),
    name: String(properties.districtna ?? 'Unspecified zoning district'),
    category: String(properties.gen ?? 'Other'),
    codeSection: properties.codesectio
      ? String(properties.codesectio)
      : undefined,
    codeUrl: properties.url ? String(properties.url) : undefined,
  };
}

function buildFilter(category: CategoryValue, search: string): FilterSpecification {
  const clauses: unknown[] = ['all'];

  if (category !== 'all') {
    clauses.push(['==', ['get', 'gen'], category]);
  }

  const query = search.trim().toLocaleLowerCase();
  if (query) {
    clauses.push([
      'any',
      ['in', query, ['downcase', ['to-string', ['get', 'zoning_sim']]]],
      ['in', query, ['downcase', ['to-string', ['get', 'districtna']]]],
    ]);
  }

  return clauses as FilterSpecification;
}

function getLabColors(profile: LabProfile) {
  if (profile === 'dry') {
    return [
      'match',
      ['get', 'gen'],
      'Commercial',
      '#2d9a82',
      'Mixed Use',
      '#2d9a82',
      'Mixed',
      '#2d9a82',
      'Industrial',
      '#e0a14c',
      '#c7c7c0',
    ];
  }

  if (profile === 'pilot') {
    return [
      'match',
      ['get', 'gen'],
      'Industrial',
      '#2d9a82',
      'Mixed Use',
      '#e0a14c',
      'Mixed',
      '#e0a14c',
      '#c7c7c0',
    ];
  }

  if (profile === 'life_science') {
    return [
      'match',
      ['get', 'gen'],
      'Industrial',
      '#e0a14c',
      'Mixed Use',
      '#e0a14c',
      'Mixed',
      '#e0a14c',
      'Commercial',
      '#d7b36f',
      '#c7c7c0',
    ];
  }

  return [
    'match',
    ['get', 'gen'],
    'Industrial',
    '#2d9a82',
    'Mixed Use',
    '#e0a14c',
    'Mixed',
    '#e0a14c',
    'Commercial',
    '#d7b36f',
    '#c7c7c0',
  ];
}

function assessZone(zone: ZoneDetails, profile: LabProfile): LabAssessment {
  const code = zone.zoning.toUpperCase();
  const isPdr = code.startsWith('PDR-');
  const isLegacyIndustrial = code === 'M-1' || code === 'M-2';
  const isUmu = code === 'UMU';
  const isMixed = zone.category === 'Mixed Use' || zone.category === 'Mixed';
  const isCommercial = zone.category === 'Commercial';
  const isIndustrial = zone.category === 'Industrial';

  if (profile === 'dry') {
    if (isCommercial || isMixed) {
      return {
        tone: 'lead',
        label: FIT_META.lead.label,
        reason:
          'This is a stronger location signal for office-like R&D. Confirm whether the proposed build-out is classified as Office or Laboratory.',
      };
    }
    if (isIndustrial) {
      return {
        tone: 'review',
        label: FIT_META.review.label,
        reason:
          'Industrial districts may accommodate research uses, but office-like activity can have separate controls.',
      };
    }
  }

  if (profile === 'standard') {
    if ((isPdr && code !== 'PDR-1-B') || isLegacyIndustrial || isUmu) {
      return {
        tone: 'lead',
        label: FIT_META.lead.label,
        reason:
          'The current Planning Code identifies ordinary Laboratory use in several PDR districts and UMU, subject to district-specific limits and use classification.',
      };
    }
    if (code === 'PDR-1-B') {
      return {
        tone: 'review',
        label: FIT_META.review.label,
        reason:
          'Laboratory use in PDR-1-B has a size limitation in the current zoning table. Confirm the proposed floor area with Planning.',
      };
    }
    if (isIndustrial || isMixed || isCommercial) {
      return {
        tone: 'review',
        label: FIT_META.review.label,
        reason:
          'This broader district type is worth screening, but the specific use table, size, floor, and any special-use overlay control the result.',
      };
    }
  }

  if (profile === 'life_science') {
    if (isPdr || isUmu) {
      return {
        tone: 'low',
        label: 'Base district caution',
        reason:
          'San Francisco treats Life Science separately from ordinary Laboratory use; current PDR and UMU tables show Life Science as not permitted unless another entitlement or special control applies.',
      };
    }
    if (isIndustrial || isMixed || isCommercial) {
      return {
        tone: 'review',
        label: FIT_META.review.label,
        reason:
          'A life-science use needs parcel-level review for its exact district, special-use controls, existing entitlements, and operating model.',
      };
    }
  }

  if (profile === 'pilot') {
    if ((isPdr && code !== 'PDR-1-B') || isLegacyIndustrial) {
      return {
        tone: 'lead',
        label: FIT_META.lead.label,
        reason:
          'PDR and legacy industrial areas are stronger first-pass leads for a project that combines research with processing, storage, or light manufacturing.',
      };
    }
    if (isIndustrial || isMixed) {
      return {
        tone: 'review',
        label: FIT_META.review.label,
        reason:
          'The manufacturing component needs its own use classification and may change occupancy, fire, loading, and environmental review.',
      };
    }
  }

  return {
    tone: 'low',
    label: FIT_META.low.label,
    reason:
      'This district is a lower-signal starting point for the selected lab model. Ask Planning to confirm whether any laboratory use is available at this parcel.',
  };
}

export default function Home() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const addressMarkerRef = useRef<Marker | null>(null);
  const hoveredFeatureRef = useRef<string | number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [zoningLoad, setZoningLoad] = useState<ZoningLoadState>({
    phase: 'connecting',
    loadedBytes: 0,
    totalBytes: null,
    featureCount: null,
  });
  const [mode, setMode] = useState<ExplorerMode>('lab');
  const [category, setCategory] = useState<CategoryValue>('all');
  const [search, setSearch] = useState('');
  const [addressQuery, setAddressQuery] = useState('');
  const [addressResults, setAddressResults] = useState<AddressResult[]>([]);
  const [addressSearching, setAddressSearching] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState<AddressResult | null>(null);
  const [labProfile, setLabProfile] = useState<LabProfile>('life_science');
  const [labNeeds, setLabNeeds] = useState<Record<LabNeed, boolean>>({
    hazmat: true,
    gases: true,
    animals: false,
    clinical: true,
  });
  const [selectedZone, setSelectedZone] = useState<ZoneDetails | null>(null);
  const [hoveredZone, setHoveredZone] = useState<ZoneDetails | null>(null);
  const [zoneCount, setZoneCount] = useState<number | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const activeCategory = useMemo(
    () => CATEGORIES.find((item) => item.value === category) ?? CATEGORIES[0],
    [category],
  );
  const activeLabProfile = useMemo(
    () => LAB_PROFILES.find((item) => item.value === labProfile) ?? LAB_PROFILES[1],
    [labProfile],
  );
  const detailZone = selectedZone ?? hoveredZone;
  const labAssessment = useMemo(
    () => (detailZone ? assessZone(detailZone, labProfile) : null),
    [detailZone, labProfile],
  );
  const downloadPercent = zoningLoad.totalBytes
    ? Math.min(100, Math.round((zoningLoad.loadedBytes / zoningLoad.totalBytes) * 100))
    : null;

  const clearHover = useCallback(() => {
    const map = mapRef.current;
    if (map && hoveredFeatureRef.current !== null) {
      map.setFeatureState(
        { source: 'sf-zoning', id: hoveredFeatureRef.current },
        { hover: false },
      );
    }
    hoveredFeatureRef.current = null;
    setHoveredZone(null);
  }, []);

  const inspectPoint = useCallback((coordinates: [number, number]) => {
    const map = mapRef.current;
    if (!map?.getLayer('zoning-fill')) return;
    const feature = map.queryRenderedFeatures(map.project(coordinates), {
      layers: ['zoning-fill'],
    })[0];
    if (feature) setSelectedZone(getZoneDetails(feature.properties ?? {}));
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      ...INITIAL_VIEW,
      minZoom: 10.5,
      maxZoom: 18,
      maxBounds: [
        [-122.58, 37.68],
        [-122.32, 37.86],
      ],
      attributionControl: false,
    });
    const zoningDownload = new AbortController();

    mapRef.current = map;
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      'top-right',
    );
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right',
    );

    map.on('load', async () => {
      let lastProgressUpdate = 0;

      try {
        const zoningData = await downloadZoningData(
          zoningDownload.signal,
          (loadedBytes, totalBytes) => {
            const now = performance.now();
            if (now - lastProgressUpdate < 100 && loadedBytes !== totalBytes) return;
            lastProgressUpdate = now;
            setZoningLoad({
              phase: 'downloading',
              loadedBytes,
              totalBytes,
              featureCount: null,
            });
          },
          () => setZoningLoad((current) => ({ ...current, phase: 'parsing' })),
        );

        if (zoningDownload.signal.aborted) return;
        setZoningLoad((current) => ({
          ...current,
          phase: 'rendering',
          featureCount: zoningData.features.length,
        }));

        map.addSource('sf-zoning', {
          type: 'geojson',
          data: zoningData,
          generateId: true,
        });

      map.addLayer({
        id: 'zoning-fill',
        type: 'fill',
        source: 'sf-zoning',
        paint: {
          'fill-color': ZONING_COLORS,
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            0.86,
            0.66,
          ],
        },
      });

      map.addLayer({
        id: 'zoning-outline',
        type: 'line',
        source: 'sf-zoning',
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            '#171917',
            'rgba(42, 45, 42, 0.34)',
          ],
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            2.2,
            ['interpolate', ['linear'], ['zoom'], 10, 0.35, 16, 1.15],
          ],
        },
      });

      map.addLayer({
        id: 'zoning-labels',
        type: 'symbol',
        source: 'sf-zoning',
        minzoom: 13.3,
        layout: {
          'text-field': ['get', 'zoning_sim'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 16, 11],
          'text-font': ['Open Sans Semibold'],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#242624',
          'text-halo-color': 'rgba(255, 252, 245, 0.88)',
          'text-halo-width': 1.25,
        },
      });

      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setLoadError(true);
        }
      }
    });

    map.on('sourcedata', (event) => {
      if (event.sourceId !== 'sf-zoning' || !event.isSourceLoaded) return;
      const source = map.getSource('sf-zoning') as GeoJSONSource | undefined;
      if (!source) return;
      setZoneCount(map.querySourceFeatures('sf-zoning').length);
      setMapReady(true);
      setZoningLoad((current) => ({ ...current, phase: 'ready' }));
    });

    const handleMouseMove = (event: MapMouseEvent) => {
      if (!map.getLayer('zoning-fill')) return;
      const feature = map.queryRenderedFeatures(event.point, {
        layers: ['zoning-fill'],
      })[0];

      if (!feature) {
        map.getCanvas().style.cursor = '';
        clearHover();
        return;
      }

      map.getCanvas().style.cursor = 'pointer';
      if (feature.id !== hoveredFeatureRef.current) {
        clearHover();
        if (feature.id !== undefined) {
          hoveredFeatureRef.current = feature.id;
          map.setFeatureState(
            { source: 'sf-zoning', id: feature.id },
            { hover: true },
          );
        }
      }
      setHoveredZone(getZoneDetails(feature.properties ?? {}));
    };

    map.on('mousemove', handleMouseMove);
    map.on('mouseout', clearHover);
    map.on('click', (event) => {
      if (!map.getLayer('zoning-fill')) return;
      const feature = map.queryRenderedFeatures(event.point, {
        layers: ['zoning-fill'],
      })[0];
      if (!feature) return;
      setSelectedAddress(null);
      setSelectedZone(getZoneDetails(feature.properties ?? {}));
      setPanelOpen(false);
    });
    map.on('error', (event) => {
      const message = String(event.error?.message ?? '');
      if (message.includes('3i4a-hu95') || message.includes('sf-zoning')) {
        setLoadError(true);
      }
    });

    return () => {
      zoningDownload.abort();
      addressMarkerRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
  }, [clearHover]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const filter = buildFilter(
      mode === 'zoning' ? category : 'all',
      mode === 'zoning' ? search : '',
    );
    ['zoning-fill', 'zoning-outline', 'zoning-labels'].forEach((layer) => {
      map.setFilter(layer, filter);
    });
    map.setPaintProperty(
      'zoning-fill',
      'fill-color',
      mode === 'lab' ? getLabColors(labProfile) : ZONING_COLORS,
    );
    clearHover();
  }, [category, search, mapReady, clearHover, mode, labProfile]);

  useEffect(() => {
    if (mode !== 'lab' || addressQuery.trim().length < 3) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setAddressSearching(true);
      const safeQuery = addressQuery.trim().toUpperCase().replaceAll("'", "''");
      const params = new URLSearchParams({
        '$select': 'address,longitude,latitude,parcel_number',
        '$where': `upper(address) like '%${safeQuery}%'`,
        '$limit': '6',
      });

      try {
        const response = await fetch(`${ADDRESS_API}?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Address lookup failed');
        const results = (await response.json()) as AddressResult[];
        setAddressResults(results.filter((item) => item.longitude && item.latitude));
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setAddressResults([]);
        }
      } finally {
        setAddressSearching(false);
      }
    }, 320);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [addressQuery, mode]);

  const switchMode = (nextMode: ExplorerMode) => {
    setMode(nextMode);
    setSelectedZone(null);
    setSelectedAddress(null);
    setSearch('');
    setCategory('all');
    setPanelOpen(false);
    addressMarkerRef.current?.remove();
    addressMarkerRef.current = null;
  };

  const selectAddress = (result: AddressResult) => {
    const coordinates: [number, number] = [
      Number(result.longitude),
      Number(result.latitude),
    ];
    const map = mapRef.current;
    if (!map || coordinates.some(Number.isNaN)) return;

    setSelectedAddress(result);
    setAddressQuery(result.address);
    setAddressResults([]);
    setSelectedZone(null);
    setPanelOpen(false);
    addressMarkerRef.current?.remove();
    const markerElement = document.createElement('span');
    markerElement.className = 'address-marker';
    addressMarkerRef.current = new maplibregl.Marker({ element: markerElement })
      .setLngLat(coordinates)
      .addTo(map);
    map.flyTo({ center: coordinates, zoom: 16.2, duration: 1100 });
    map.once('idle', () => inspectPoint(coordinates));
  };

  const toggleNeed = (need: LabNeed) => {
    setLabNeeds((current) => ({ ...current, [need]: !current[need] }));
  };

  const resetView = () => {
    addressMarkerRef.current?.remove();
    addressMarkerRef.current = null;
    setSelectedAddress(null);
    setSelectedZone(null);
    mapRef.current?.easeTo({ ...INITIAL_VIEW, duration: 900 });
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#map" aria-label="SF Zoning Atlas home">
          <span className="brand-mark">SF</span>
          <span>Zoning Atlas</span>
        </a>
        <nav className="mode-switch" aria-label="Explorer mode">
          <button
            type="button"
            className={mode === 'zoning' ? 'active' : ''}
            onClick={() => switchMode('zoning')}
            aria-pressed={mode === 'zoning'}
          >
            Zoning
          </button>
          <button
            type="button"
            className={mode === 'lab' ? 'active' : ''}
            onClick={() => switchMode('lab')}
            aria-pressed={mode === 'lab'}
          >
            Bio lab planner
          </button>
        </nav>
        <a
          className="planning-link"
          href="https://sfplanning.org/zoning"
          target="_blank"
          rel="noreferrer"
        >
          SF Planning <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className={`workspace ${mode === 'lab' ? 'lab-mode' : ''}`}>
        <aside className={`side-panel ${panelOpen ? 'panel-open' : ''}`}>
          <div className="intro-block">
            <p className="eyebrow">
              {mode === 'lab' ? 'Bio lab location screener' : 'San Francisco zoning explorer'}
            </p>
            <h1>
              {mode === 'lab' ? (
                <>Find a smarter<br />place to start.</>
              ) : (
                <>Read the city,<br />parcel by parcel.</>
              )}
            </h1>
            <p className="lede">
              {mode === 'lab'
                ? 'Screen an address against its zoning signal, then build a tailored list of questions for Planning, Fire, building, and health review.'
                : 'Explore current use districts across San Francisco. Filter the map or select a zone to open its Planning Code reference.'}
            </p>
          </div>

          {mode === 'zoning' ? (
            <>
              <div className="search-block">
                <label htmlFor="zone-search">Find a zone</label>
                <div className="search-input-wrap">
                  <span aria-hidden="true" className="search-icon" />
                  <input
                    id="zone-search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Try RH-2 or neighborhood commercial"
                    autoComplete="off"
                  />
                  {search && (
                    <button
                      type="button"
                      className="clear-search"
                      onClick={() => setSearch('')}
                      aria-label="Clear zone search"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>

              <div className="filter-block">
                <div className="section-heading">
                  <span>District type</span>
                  <span className="count-label">
                    {zoneCount ? `${zoneCount.toLocaleString()} shapes` : 'Loading…'}
                  </span>
                </div>
                <div className="category-list" role="list" aria-label="Zoning categories">
                  {CATEGORIES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={`category-button ${category === item.value ? 'active' : ''}`}
                      onClick={() => setCategory(item.value)}
                      aria-pressed={category === item.value}
                    >
                      <span className="category-swatch" style={{ backgroundColor: item.color }} />
                      <span>{item.label}</span>
                      {category === item.value && <span className="category-check">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="search-block address-search-block">
                <label htmlFor="address-search">Search a San Francisco address</label>
                <div className="search-input-wrap">
                  <span aria-hidden="true" className="search-icon" />
                  <input
                    id="address-search"
                    value={addressQuery}
                    onChange={(event) => {
                      setAddressQuery(event.target.value);
                      setSelectedAddress(null);
                    }}
                    placeholder="455 Mission Street"
                    autoComplete="street-address"
                  />
                  {addressSearching && <span className="mini-spinner" aria-label="Searching" />}
                  {addressQuery && !addressSearching && (
                    <button
                      type="button"
                      className="clear-search"
                      onClick={() => {
                        setAddressQuery('');
                        setAddressResults([]);
                        setSelectedAddress(null);
                      }}
                      aria-label="Clear address search"
                    >
                      ×
                    </button>
                  )}
                </div>
                {mode === 'lab' && addressQuery.trim().length >= 3 && addressResults.length > 0 && (
                  <div className="address-results" role="listbox" aria-label="Address results">
                    {addressResults.map((result) => (
                      <button
                        key={`${result.address}-${result.parcel_number ?? result.longitude}`}
                        type="button"
                        onClick={() => selectAddress(result)}
                        role="option"
                        aria-selected={selectedAddress?.address === result.address}
                      >
                        <strong>{result.address}</strong>
                        <span>{result.parcel_number ? `Parcel ${result.parcel_number}` : 'San Francisco'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="lab-step">
                <div className="section-heading">
                  <span>1 · Choose your lab model</span>
                </div>
                <div className="lab-profile-list">
                  {LAB_PROFILES.map((profile) => (
                    <button
                      key={profile.value}
                      type="button"
                      className={labProfile === profile.value ? 'active' : ''}
                      onClick={() => setLabProfile(profile.value)}
                      aria-pressed={labProfile === profile.value}
                    >
                      <span className="profile-radio" />
                      <span>
                        <strong>{profile.label}</strong>
                        <small>{profile.detail}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="lab-step needs-step">
                <div className="section-heading">
                  <span>2 · Flag operational needs</span>
                </div>
                <div className="needs-grid">
                  {([
                    ['hazmat', 'Hazardous materials'],
                    ['gases', 'Compressed gas / cryogens'],
                    ['animals', 'Animals / vivarium'],
                    ['clinical', 'Clinical samples / medical waste'],
                  ] as [LabNeed, string][]).map(([need, label]) => (
                    <label key={need}>
                      <input
                        type="checkbox"
                        checked={labNeeds[need]}
                        onChange={() => toggleNeed(need)}
                      />
                      <span className="check-box" aria-hidden="true">✓</span>
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="lab-checklist">
                <div className="section-heading">
                  <span>3 · Early review checklist</span>
                </div>
                <ol>
                  <li>
                    <span>01</span>
                    <p><strong>Confirm land-use classification</strong>Ask Planning whether the operation is Office, Laboratory, Life Science, and/or Manufacturing.</p>
                  </li>
                  <li>
                    <span>02</span>
                    <p><strong>Test the building</strong>Have a code professional review occupancy, ventilation, egress, plumbing, power, loading, and tenant improvements.</p>
                  </li>
                  {(labNeeds.hazmat || labNeeds.gases || labProfile === 'pilot') && (
                    <li>
                      <span>03</span>
                      <p><strong>Inventory regulated materials</strong>Quantities can trigger Fire permits, control areas, hazardous occupancy, and CUPA/CERS duties.</p>
                    </li>
                  )}
                  {(labNeeds.clinical || labProfile === 'life_science') && (
                    <li>
                      <span>04</span>
                      <p><strong>Plan biosafety and waste</strong>Document a protocol-driven risk assessment and determine medical-waste obligations.</p>
                    </li>
                  )}
                  {labNeeds.animals && (
                    <li>
                      <span>05</span>
                      <p><strong>Review the vivarium separately</strong>Animal facilities add land-use, welfare, ventilation, waste, and institutional oversight questions.</p>
                    </li>
                  )}
                </ol>
                <div className="resource-links">
                  <a href="https://sf-fire.org/services/permits" target="_blank" rel="noreferrer">Fire permits ↗</a>
                  <a href="https://www.sf.gov/resource--2023--building-inspection-division" target="_blank" rel="noreferrer">Building review ↗</a>
                  <a href="https://www.cdc.gov/labs/bmbl/index.html" target="_blank" rel="noreferrer">CDC/NIH biosafety ↗</a>
                </div>
              </div>
            </>
          )}

          <div className="panel-note">
            <span className="note-index">{mode === 'lab' ? '!' : '01'}</span>
            <p>
              {mode === 'lab'
                ? 'This is an early screening aid, not a zoning or permit determination. District tables, special-use controls, building conditions, materials, quantities, and procedures all matter.'
                : 'Boundaries are for exploration. Confirm a property’s zoning with the official SF Planning map before making decisions.'}
            </p>
          </div>
        </aside>

        <section className="map-stage" id="map" aria-label="Interactive San Francisco zoning map">
          <div ref={mapContainerRef} className="map-canvas" />

          {!mapReady && !loadError && (
            <div className="map-loading" role="status">
              <div className="loading-heading">
                <span className="loading-spinner" />
                <strong>
                  {zoningLoad.phase === 'connecting' && 'Connecting to SF Open Data…'}
                  {zoningLoad.phase === 'downloading' && 'Downloading zoning boundaries…'}
                  {zoningLoad.phase === 'parsing' && 'Preparing downloaded boundaries…'}
                  {zoningLoad.phase === 'rendering' && 'Drawing zoning districts…'}
                </strong>
              </div>
              <div
                className={`download-progress ${downloadPercent === null ? 'indeterminate' : ''}`}
                role="progressbar"
                aria-label="Zoning boundary download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                {...(downloadPercent !== null ? { 'aria-valuenow': downloadPercent } : {})}
              >
                <span style={downloadPercent !== null ? { width: `${downloadPercent}%` } : undefined} />
              </div>
              <span className="loading-detail">
                {zoningLoad.phase === 'connecting' && 'Starting the official city data request'}
                {zoningLoad.phase === 'downloading' && (
                  zoningLoad.totalBytes
                    ? `${downloadPercent}% · ${formatBytes(zoningLoad.loadedBytes)} of ${formatBytes(zoningLoad.totalBytes)}`
                    : `${formatBytes(zoningLoad.loadedBytes)} received`
                )}
                {zoningLoad.phase === 'parsing' && `${formatBytes(zoningLoad.loadedBytes)} downloaded`}
                {zoningLoad.phase === 'rendering' && (
                  zoningLoad.featureCount
                    ? `Placing ${zoningLoad.featureCount.toLocaleString()} district shapes on the map`
                    : 'Placing district shapes on the map'
                )}
              </span>
            </div>
          )}

          {loadError && (
            <div className="map-error" role="alert">
              <strong>The zoning layer couldn’t load.</strong>
              <span>Check your connection and refresh to try again.</span>
            </div>
          )}

          <div className="map-toolbar">
            <button type="button" onClick={resetView} aria-label="Reset map to San Francisco">
              <span className="target-icon" aria-hidden="true" />
              Reset view
            </button>
            <span className="toolbar-divider" />
            <span className="active-layer">
              <i style={{ backgroundColor: mode === 'lab' ? '#2d9a82' : activeCategory.color }} />
              {mode === 'lab' ? `${activeLabProfile.shortLabel} screening` : activeCategory.label}
            </span>
          </div>

          {mode === 'lab' && (
            <div className="lab-map-legend" aria-label="Lab screening legend">
              <p>First-pass location signal</p>
              <span><i className="lead" /> Better lead</span>
              <span><i className="review" /> Review</span>
              <span><i className="low" /> Lower signal</span>
            </div>
          )}

          {detailZone && (
            <article className={`zone-card ${mode === 'lab' ? 'lab-zone-card' : ''}`} aria-live="polite">
              <button
                type="button"
                className="zone-card-close"
                onClick={() => {
                  setSelectedZone(null);
                  setSelectedAddress(null);
                  setPanelOpen(false);
                }}
                aria-label="Close zone details"
              >
                ×
              </button>
              {selectedAddress && mode === 'lab' && (
                <p className="selected-address">{selectedAddress.address}</p>
              )}
              <div className="zone-card-topline">
                <span className="zone-code">{detailZone.zoning}</span>
                <span className="zone-category">{detailZone.category}</span>
              </div>
              <h2>{detailZone.name.toLocaleLowerCase()}</h2>
              {mode === 'lab' && labAssessment ? (
                <div className={`fit-result ${labAssessment.tone}`}>
                  <span className="fit-label">
                    <i style={{ backgroundColor: FIT_META[labAssessment.tone].color }} />
                    {labAssessment.label}
                  </span>
                  <p>{labAssessment.reason}</p>
                  <small>Screening for: {activeLabProfile.label}</small>
                </div>
              ) : (
                <div className="zone-card-meta">
                  <span>Use district</span>
                  <strong>
                    {detailZone.codeSection ? `Code § ${detailZone.codeSection}` : 'See Planning Code'}
                  </strong>
                </div>
              )}
              <div className="zone-card-links">
                {detailZone.codeUrl && (
                  <a href={detailZone.codeUrl} target="_blank" rel="noreferrer">
                    District code <span aria-hidden="true">↗</span>
                  </a>
                )}
                {mode === 'lab' && (
                  <a href="https://propertymap.sfplanning.org/" target="_blank" rel="noreferrer">
                    Verify parcel <span aria-hidden="true">↗</span>
                  </a>
                )}
              </div>
            </article>
          )}

          {!detailZone && mapReady && (
            <div className="map-hint">
              <span className="cursor-dot" aria-hidden="true" />
              {mode === 'lab'
                ? 'Search an address or tap a district to screen it'
                : 'Hover or tap a district to inspect it'}
            </div>
          )}

          <button
            type="button"
            className="mobile-panel-toggle"
            onClick={() => setPanelOpen((open) => !open)}
            aria-expanded={panelOpen}
          >
            {panelOpen ? 'Hide planner' : mode === 'lab' ? 'Open lab planner' : 'Explore zones'}
          </button>
        </section>
      </section>
    </main>
  );
}
