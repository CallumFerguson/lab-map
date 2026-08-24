'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, {
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
  center: [-122.424, 37.758] as [number, number],
  zoom: 11.7,
  bearing: 0,
  pitch: 0,
};

const STRONG_CODES = new Set([
  'C-2',
  'M-1',
  'M-2',
  'MB-RA',
  'CMUO',
  'MUG',
  'SALI',
  'UMU',
  'PDR-1-D',
  'PDR-1-G',
  'PDR-2',
]);
const HISTORIC_PATH_CODES = new Set([
  'MUO',
  'MUR',
  'SPD',
  'WMUG',
  'WMUO',
]);

type FitTone = 'strong' | 'review' | 'low';
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
  confidence: string;
  summary: string;
  evidence: string[];
  verify: string[];
};

const FIT_META: Record<FitTone, { label: string; color: string }> = {
  strong: { label: 'Strong location lead', color: '#14856f' },
  review: { label: 'Manual review needed', color: '#d28a27' },
  low: { label: 'Lower-fit starting point', color: '#9a9c96' },
};

const LAB_FILL_COLORS = [
  'match',
  ['get', 'lab_fit'],
  'strong',
  FIT_META.strong.color,
  'review',
  '#e2a34a',
  '#c5c5be',
];

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFitTone(codeValue: unknown, categoryValue: unknown): FitTone {
  const code = String(codeValue ?? '').toUpperCase();
  const category = String(categoryValue ?? '');

  if (STRONG_CODES.has(code) || code.startsWith('C-3-')) return 'strong';
  if (
    code.startsWith('PDR-') ||
    HISTORIC_PATH_CODES.has(code) ||
    code === 'PPS-MU' ||
    code === 'MB-O' ||
    category === 'Industrial' ||
    category === 'Mixed Use' ||
    category === 'Mixed'
  ) {
    return 'review';
  }
  return 'low';
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

function assessZone(zone: ZoneDetails): LabAssessment {
  const code = zone.zoning.toUpperCase();

  if (code === 'C-2' || code.startsWith('C-3-')) {
    return {
      tone: 'strong',
      label: 'Laboratory use permitted',
      confidence: 'High confidence in the base-zoning signal',
      summary:
        'The current district table principally permits Laboratory use. Commercial buildings vary widely, so building systems and a feasible change of use may be more limiting than base zoning.',
      evidence: [
        'Laboratory is included in Non-Retail Sales and Service under the Planning Code.',
        `${code} principally permits the applicable use class.`,
      ],
      verify: [
        'Parcel overlays, prior conditions, and any change of use',
        'A building layout capable of BSL-2 practices, lab HVAC, gas storage, and waste handling',
      ],
    };
  }

  if (code === 'M-1') {
    return {
      tone: 'strong',
      label: 'Laboratory use permitted',
      confidence: 'High confidence in the base-zoning signal',
      summary:
        'The current M-district table principally permits Non-Retail Sales and Service, the use class that includes Laboratory. This is a clear base-zoning signal for the proposed research lab.',
      evidence: [
        'Laboratory covers facilities used for scientific research, including BSL-1, BSL-2, and BSL-3 biological laboratories.',
        'M-1 permits the broader Non-Retail Sales and Service use class.',
      ],
      verify: [
        'Parcel overlays, prior conditions, and any change of use',
        'A building layout capable of BSL-2 practices, lab HVAC, gas storage, and waste handling',
      ],
    };
  }

  if (code === 'M-2') {
    return {
      tone: 'strong',
      label: 'Strong zoning lead',
      confidence: 'High base-zoning confidence; site context matters',
      summary:
        'M-2 has the same strong base-use signal as M-1. Much of San Francisco’s M-2 land is Port-controlled or heavy-industrial, so lease controls, access, and building quality deserve extra scrutiny.',
      evidence: [
        'The M-district table permits Non-Retail Sales and Service in M-2.',
        'Laboratory sits within that use class under the current Planning Code.',
      ],
      verify: [
        'Port or other landowner controls and parcel-specific entitlements',
        'Flood, seismic, utility, emergency-power, and employee-access conditions',
      ],
    };
  }

  if (code === 'MB-RA') {
    return {
      tone: 'strong',
      label: 'Established laboratory area',
      confidence: 'High location confidence; parcel approval still required',
      summary:
        'Mission Bay is an established biotech and laboratory cluster with substantial lab-ready space. OCII redevelopment documents—not this base-zoning layer alone—control each parcel.',
      evidence: [
        'Mission Bay was planned and built with substantial laboratory and biotech space.',
        'Existing lab buildings can reduce the hardest HVAC, power, gas, and waste-route problems.',
      ],
      verify: [
        'The parcel’s Mission Bay redevelopment plan and permitted-use documents',
        'Whether the offered suite already supports the proposed biosafety and automation program',
      ],
    };
  }

  if (['PDR-1-D', 'PDR-1-G', 'PDR-2'].includes(code)) {
    return {
      tone: 'strong',
      label: 'Laboratory use permitted',
      confidence: 'High confidence in the base-zoning signal',
      summary:
        'The current PDR table principally permits Laboratory use in this district. The proposed wet-lab operations still require building, fire, biosafety, and waste review.',
      evidence: [
        'Laboratory is listed as principally permitted in this PDR district.',
        'The screen uses Laboratory only and does not apply the separate Life Science restriction.',
      ],
      verify: [
        'Parcel overlays, prior conditions, and the proposed occupancy or change of use',
        'Ventilation, CO₂ storage, emergency power, biosafety, and medical-waste handling',
      ],
    };
  }

  if (code === 'PDR-1-B') {
    return {
      tone: 'review',
      label: 'Size-limited laboratory path',
      confidence: 'High confidence; suite area controls the result',
      summary:
        'Laboratory is principally permitted in PDR-1-B only up to 2,500 gross square feet. A larger lab needs direct Planning review before relying on this district.',
      evidence: [
        'The PDR table lists Laboratory as principally permitted with a size limitation.',
        'The citywide zoning layer does not include the proposed lab floor area.',
      ],
      verify: [
        'The gross square footage devoted to the laboratory use',
        'Any parcel overlays, prior approvals, or other controlling conditions',
      ],
    };
  }

  if (['CMUO', 'MUG', 'SALI', 'UMU'].includes(code)) {
    return {
      tone: 'strong',
      label: 'Laboratory use permitted',
      confidence: 'High confidence in the base-zoning signal',
      summary:
        'This district principally permits Non-Retail Sales and Service, which includes Laboratory. The separate restriction on Life Science is not applied because this screen is fixed to Laboratory only.',
      evidence: [
        'The district principally permits Non-Retail Sales and Service.',
        'Laboratory is a use within that category under the current Planning Code.',
      ],
      verify: [
        'Written confirmation that the proposed program remains classified as Laboratory',
        'Building conversion, ventilation, fire, gas, biosafety, and waste requirements',
      ],
    };
  }

  if (code === 'PPS-MU') {
    return {
      tone: 'review',
      label: 'Promising only on named blocks',
      confidence: 'Medium confidence; block lookup required',
      summary:
        'The Potrero Power Station district permits Laboratory on Blocks 2, 3, 11, 12, and 15, but not across the whole district. This map layer does not identify those blocks.',
      evidence: [
        'A specific Laboratory pathway exists in the special-use district.',
        'The citywide zoning polygon is too coarse to tell whether a clicked site is on an eligible block.',
      ],
      verify: [
        'The official PPS block number and applicable special-use table',
        'Development-phase timing, landlord delivery scope, and lab-ready infrastructure',
      ],
    };
  }

  if (code.startsWith('PDR-')) {
    return {
      tone: 'review',
      label: 'District-specific review needed',
      confidence: 'Medium confidence from the citywide layer',
      summary:
        'This PDR designation is not one of the clear Laboratory permissions identified by this screen. Confirm the exact current district table before pursuing a lease.',
      evidence: [
        'PDR districts have different controls for Laboratory use.',
        'The broad PDR category alone is not a permit determination.',
      ],
      verify: [
        'The exact Laboratory entry in the applicable district table',
        'Whether a special entitlement, prior approval, or another controlling plan changes the result',
      ],
    };
  }

  if (HISTORIC_PATH_CODES.has(code)) {
    return {
      tone: 'review',
      label: 'Possible historic-building pathway',
      confidence: 'Medium confidence; building status controls the answer',
      summary:
        'The base table generally does not permit Laboratory here. A current rule can permit the use in a qualifying historic building, so the building—not just the zoning polygon—determines whether this is viable.',
      evidence: [
        'Laboratory is generally not permitted in this mixed-use base district.',
        'Qualifying historic buildings can receive a broader principally permitted use pathway.',
      ],
      verify: [
        'Whether the exact building qualifies under Planning Code §803.9(c)',
        'Historic-preservation constraints on vents, rooftop equipment, generators, and interior work',
      ],
    };
  }

  if (code === 'MB-O') {
    return {
      tone: 'review',
      label: 'Mission Bay plan review',
      confidence: 'Medium confidence; redevelopment documents control',
      summary:
        'This Mission Bay office designation sits in a strong laboratory ecosystem, but the zoning label alone does not establish that Laboratory use is allowed in the specific building.',
      evidence: ['Mission Bay has extensive laboratory activity.', 'Parcel-level OCII documents govern allowed uses.'],
      verify: ['The applicable Mission Bay plan and owner entitlement', 'Existing lab occupancy and building systems'],
    };
  }

  if (
    zone.category === 'Industrial' ||
    zone.category === 'Mixed Use' ||
    zone.category === 'Mixed'
  ) {
    return {
      tone: 'review',
      label: 'Special controls need review',
      confidence: 'Low-to-medium confidence from this layer alone',
      summary:
        'This broader district type may have a path, but it is not one of the citywide layer’s clear high-confidence signals for Laboratory. The exact district table and any special plan control the answer.',
      evidence: ['The broad district category is not a legal use determination.', 'Laboratory has its own Planning Code definition and controls.'],
      verify: ['The exact current use table and overlays', 'Any prior approvals tied to the parcel or building'],
    };
  }

  return {
    tone: 'low',
    label: 'Lower-fit starting point',
    confidence: 'High confidence that no clear base-zoning path is shown',
    summary:
      'This district does not provide a clear Laboratory path in the citywide screen. It may still have a parcel-specific exception, but it is a less efficient place to begin a site search.',
    evidence: ['The district is not identified as a strong or conditional Laboratory location.', 'A parcel exception cannot be ruled out from this dataset.'],
    verify: ['Whether a special district, existing entitlement, or legal nonconforming use applies', 'Whether a different site would avoid entitlement time and risk'],
  };
}

const BUILDING_CHECKS = [
  'Existing lab occupancy or a feasible change of use',
  'BSL-2 work practices and a suitable Class II biosafety cabinet setup',
  'Stable HVAC, temperature, humidity, sinks, eyewash, and decontamination route',
  'CO₂ storage, ventilation/alarm strategy, seismic restraint, and Fire review',
  'Clean power, data, bench capacity, and backup power for incubators, freezers, and automation',
  'Biohazard/medical-waste storage and a practical pickup route',
];

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
  const [addressQuery, setAddressQuery] = useState('');
  const [addressResults, setAddressResults] = useState<AddressResult[]>([]);
  const [addressSearching, setAddressSearching] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState<AddressResult | null>(null);
  const [selectedZone, setSelectedZone] = useState<ZoneDetails | null>(null);
  const [hoveredZone, setHoveredZone] = useState<ZoneDetails | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const detailZone = selectedZone ?? hoveredZone;
  const assessment = useMemo(
    () => (detailZone ? assessZone(detailZone) : null),
    [detailZone],
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
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

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
        const screeningData: FeatureCollection<Geometry> = {
          ...zoningData,
          features: zoningData.features.map((feature) => ({
            ...feature,
            properties: {
              ...(feature.properties ?? {}),
              lab_fit: getFitTone(
                feature.properties?.zoning_sim ?? feature.properties?.zoning,
                feature.properties?.gen,
              ),
            },
          })),
        };

        setZoningLoad((current) => ({
          ...current,
          phase: 'rendering',
          featureCount: screeningData.features.length,
        }));

        map.addSource('sf-zoning', {
          type: 'geojson',
          data: screeningData,
          generateId: true,
        });

        map.addLayer({
          id: 'zoning-fill',
          type: 'fill',
          source: 'sf-zoning',
          paint: {
            'fill-color': LAB_FILL_COLORS,
            'fill-opacity': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              0.9,
              0.72,
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
            'text-halo-color': 'rgba(255, 252, 245, 0.9)',
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
          map.setFeatureState({ source: 'sf-zoning', id: feature.id }, { hover: true });
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
      setPanelOpen(true);
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
    if (addressQuery.trim().length < 3 || selectedAddress?.address === addressQuery) return;

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
  }, [addressQuery, selectedAddress]);

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
    setPanelOpen(true);
    addressMarkerRef.current?.remove();
    const markerElement = document.createElement('span');
    markerElement.className = 'address-marker';
    addressMarkerRef.current = new maplibregl.Marker({ element: markerElement })
      .setLngLat(coordinates)
      .addTo(map);
    map.flyTo({ center: coordinates, zoom: 16.2, duration: 1100 });
    map.once('idle', () => inspectPoint(coordinates));
  };

  const resetView = () => {
    addressMarkerRef.current?.remove();
    addressMarkerRef.current = null;
    setAddressQuery('');
    setAddressResults([]);
    setSelectedAddress(null);
    setSelectedZone(null);
    setPanelOpen(false);
    mapRef.current?.easeTo({ ...INITIAL_VIEW, duration: 900 });
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#map" aria-label="SF Bio Lab Site Finder home">
          <span className="brand-mark">SF</span>
          <span>Bio Lab Site Finder</span>
        </a>
        <p className="dataset-status">
          <span className={`status-dot ${loadError ? 'error' : ''}`} />
          {loadError ? 'City layer unavailable' : mapReady ? 'Official zoning layer loaded' : 'Loading city zoning data'}
        </p>
        <a
          className="planning-link"
          href="https://sfplanning.org/zoning"
          target="_blank"
          rel="noreferrer"
        >
          SF Planning <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="workspace lab-workspace">
        <aside className={`side-panel ${panelOpen ? 'panel-open' : ''}`}>
          <div className="intro-block">
            <p className="eyebrow">iPSC lab location screener</p>
            <h1>Find a viable<br />place to start.</h1>
            <p className="lede">
              Built specifically for automated bioelectric research using human iPSC-derived liver cells.
            </p>
          </div>

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
            {addressQuery.trim().length >= 3 && addressResults.length > 0 && (
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

          <section className="fixed-profile" aria-labelledby="profile-title">
            <div className="section-heading">
              <span id="profile-title">Fixed screening profile</span>
              <span className="profile-lock">Tailored</span>
            </div>
            <div className="profile-tags">
              <span>Laboratory classification only</span>
              <span>Human iPSC liver cells</span>
              <span>Bioelectric R&amp;D</span>
              <span>BSL-2 practices</span>
              <span>Opentrons automation</span>
              <span>Automated CO₂ incubation</span>
              <span>Biohazard waste</span>
            </div>
            <p>Land-use screening assumes Laboratory—not Life Science. No animals or manufacturing assumed.</p>
          </section>

          {detailZone && assessment ? (
            <article className="assessment-panel" aria-live="polite">
              {selectedAddress && <p className="selected-address">{selectedAddress.address}</p>}
              <div className="zone-card-topline">
                <span className="zone-code">{detailZone.zoning}</span>
                <span className="zone-category">{detailZone.category}</span>
              </div>
              <h2>{detailZone.name.toLocaleLowerCase()}</h2>
              <div className={`fit-result ${assessment.tone}`}>
                <span className="fit-label">
                  <i style={{ backgroundColor: FIT_META[assessment.tone].color }} />
                  {assessment.label}
                </span>
                <strong className="confidence-line">{assessment.confidence}</strong>
                <p>{assessment.summary}</p>
              </div>

              <div className="detail-list">
                <h3>Why this signal</h3>
                <ul>{assessment.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
              <div className="detail-list">
                <h3>Verify before a lease</h3>
                <ul>{assessment.verify.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>

              <div className="zone-card-links">
                {detailZone.codeUrl && (
                  <a href={detailZone.codeUrl} target="_blank" rel="noreferrer">District code ↗</a>
                )}
                <a href="https://propertymap.sfplanning.org/" target="_blank" rel="noreferrer">Verify parcel ↗</a>
              </div>
            </article>
          ) : (
            <section className="screening-guide">
              <div className="section-heading"><span>How to read the map</span></div>
              <div className="guide-row strong"><i /> <p><strong>Strong lead</strong>Laboratory is principally permitted or the plan area has strong lab support.</p></div>
              <div className="guide-row review"><i /> <p><strong>Manual review</strong>A known condition, special plan, or use-classification issue controls.</p></div>
              <div className="guide-row low"><i /> <p><strong>Lower fit</strong>No clear Laboratory path appears in this first-pass layer.</p></div>
            </section>
          )}

          <details className="building-review">
            <summary>Building readiness checklist</summary>
            <ul>{BUILDING_CHECKS.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>

          <div className="resource-links">
            <a href="https://codelibrary.amlegal.com/codes/san_francisco/latest/sf_planning/0-0-0-49163" target="_blank" rel="noreferrer">Laboratory definition ↗</a>
            <a href="https://sf-fire.org/services/permits" target="_blank" rel="noreferrer">Fire permits ↗</a>
            <a href="https://www.cdc.gov/labs/bmbl/index.html" target="_blank" rel="noreferrer">CDC biosafety ↗</a>
          </div>

          <div className="panel-note">
            <span className="note-index">!</span>
            <p>This is an early site screen, not a permit determination. Green means Laboratory is principally permitted in the base district or supported by strong plan-area evidence—not that every suite is lab-ready.</p>
          </div>
        </aside>

        <section className="map-stage" id="map" aria-label="Interactive San Francisco bio lab suitability map">
          <div ref={mapContainerRef} className="map-canvas" />

          {!mapReady && !loadError && (
            <div className="map-loading" role="status">
              <div className="loading-heading">
                <span className="loading-spinner" />
                <strong>
                  {zoningLoad.phase === 'connecting' && 'Connecting to SF Open Data…'}
                  {zoningLoad.phase === 'downloading' && 'Downloading zoning boundaries…'}
                  {zoningLoad.phase === 'parsing' && 'Preparing downloaded boundaries…'}
                  {zoningLoad.phase === 'rendering' && 'Scoring districts for your lab…'}
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
                    ? `Assessing ${zoningLoad.featureCount.toLocaleString()} district shapes`
                    : 'Assessing district shapes'
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
            <span className="active-layer"><i /> iPSC lab screening</span>
          </div>

          <div className="lab-map-legend" aria-label="Lab screening legend">
            <p>Location signal</p>
            <span><i className="strong" /> Strong lead</span>
            <span><i className="review" /> Manual review</span>
            <span><i className="low" /> Lower fit</span>
          </div>

          {!detailZone && mapReady && (
            <div className="map-hint">
              <span className="cursor-dot" aria-hidden="true" />
              Search an address or select a district
            </div>
          )}

          <button
            type="button"
            className="mobile-panel-toggle"
            onClick={() => setPanelOpen((open) => !open)}
            aria-expanded={panelOpen}
          >
            {panelOpen ? 'Hide details' : detailZone ? 'View location details' : 'Open site guide'}
          </button>
        </section>
      </section>
    </main>
  );
}
