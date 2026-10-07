import React, { useState, useCallback, useEffect } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useColors } from '@/hooks/useColors';
import { useDownloads } from '@/context/DownloadContext';
import {
  getGetDramaCatalogQueryKey,
  useGetDramaCatalog,
  type DramaCatalogItem,
} from '@workspace/api-client-react';

const SAMPLE_URL =
  'https://dramadizilerim.com/izle/yoksul-kocam-isik-tanrisi?s=1&e=1';

interface Episode {
  num: number;
  token: string;
  tokenType: string;
}

interface SeriesInfo {
  title: string;
  slug: string;
  season: string;
  totalEpisodes: number;
  episodes: Episode[];
  episodeUrl: string;
}

function getApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain || domain === 'REPLACE_WITH_DEPLOYED_API_DOMAIN' || domain === 'undefined') {
    throw new Error('API sunucusu yapılandırılmamış. Lütfen uygulamayı yeniden derleyin.');
  }
  return `https://${domain}/api/drama`;
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { addEpisodes, downloads } = useDownloads();

  const [url, setUrl] = useState('');
  const [catalogSearchText, setCatalogSearchText] = useState('');
  const [activeCatalogSearch, setActiveCatalogSearch] = useState('');
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogItems, setCatalogItems] = useState<DramaCatalogItem[]>([]);
  const [manualUrlOpen, setManualUrlOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<SeriesInfo | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const catalogParams = {
    q: activeCatalogSearch || undefined,
    page: catalogPage,
  };
  const catalogQuery = useGetDramaCatalog(
    catalogParams,
    {
      query: {
        queryKey: getGetDramaCatalogQueryKey(catalogParams),
        staleTime: 5 * 60 * 1000,
        retry: 1,
      },
    },
  );

  useEffect(() => {
    const pageData = catalogQuery.data;
    if (!pageData) return;

    setCatalogItems((previous) => {
      if (catalogPage === 1) return pageData.items;
      const existingUrls = new Set(previous.map((item) => item.url));
      return [
        ...previous,
        ...pageData.items.filter((item) => !existingUrls.has(item.url)),
      ];
    });
  }, [catalogQuery.data, catalogPage]);

  const handleCatalogSearch = useCallback(() => {
    const query = catalogSearchText.trim();
    if (query === activeCatalogSearch && catalogPage === 1) {
      void catalogQuery.refetch();
      return;
    }

    setError(null);
    setSeries(null);
    setCatalogItems([]);
    setCatalogPage(1);
    setActiveCatalogSearch(query);
  }, [
    activeCatalogSearch,
    catalogPage,
    catalogQuery.refetch,
    catalogSearchText,
  ]);

  const handleFetch = useCallback(async (inputUrl: string = url) => {
    const trimmed = inputUrl.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setSeries(null);
    setSelected(new Set());
    setUrl(trimmed);

    try {
      const res = await fetch(
        `${getApiBase()}/extract?url=${encodeURIComponent(trimmed)}`
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data: SeriesInfo = await res.json();
      setSeries(data);
      setUrl(data.episodeUrl || trimmed);
      // Select all by default
      setSelected(new Set(data.episodes.map((e) => e.num)));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Bağlantı hatası';
      setError(msg);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }, [url]);

  const handleSelectCatalogItem = useCallback((item: DramaCatalogItem) => {
    setManualUrlOpen(false);
    void handleFetch(item.url);
  }, [handleFetch]);

  const toggleEpisode = useCallback((num: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (!series) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (selected.size === series.episodes.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(series.episodes.map((e) => e.num)));
    }
  }, [series, selected]);

  const handleDownload = useCallback(() => {
    if (!series) return;
    const toDownload = series.episodes.filter((e) => selected.has(e.num));
    if (toDownload.length === 0) return;

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    addEpisodes(
      toDownload.map((ep) => ({
        num: ep.num,
        token: ep.token,
        tokenType: ep.tokenType,
        slug: series.slug,
        season: series.season,
        title: series.title,
        episodeUrl: url.trim(),
      }))
    );
  }, [series, selected, addEpisodes, url]);

  const queuedCount = downloads.filter(
    (d) => d.status === 'queued' || d.status === 'extracting'
  ).length;

  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: topPad + 16, backgroundColor: colors.background },
        ]}
      >
        <Text style={[styles.logo, { color: colors.primary }]}>▶</Text>
        <View>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            Drama İndirici
          </Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            Otomatik bölüm indirme
          </Text>
        </View>
        {queuedCount > 0 && (
          <View style={[styles.badge, { backgroundColor: colors.primary }]}>
            <Text style={styles.badgeText}>{queuedCount}</Text>
          </View>
        )}
      </View>

      <KeyboardAwareScrollViewCompat
        bottomOffset={20}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {!series && (
          <>
            <View
              style={[
                styles.inputCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.label, { color: colors.mutedForeground }]}>
                Drama Dizilerim kataloğu
              </Text>
              <View style={styles.catalogSearchRow}>
                <TextInput
                  style={[
                    styles.catalogSearchInput,
                    {
                      color: colors.foreground,
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                  value={catalogSearchText}
                  onChangeText={setCatalogSearchText}
                  placeholder="Dizi adı ara..."
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  onSubmitEditing={handleCatalogSearch}
                />
                <TouchableOpacity
                  style={[
                    styles.catalogSearchBtn,
                    { backgroundColor: colors.primary },
                  ]}
                  onPress={handleCatalogSearch}
                  activeOpacity={0.85}
                  accessibilityLabel="Dizi ara"
                >
                  <Feather name="search" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
              <Text style={[styles.catalogCaption, { color: colors.mutedForeground }]}>
                Listeden dizi seçince bölümleri otomatik bulunur.
              </Text>
            </View>

            {catalogQuery.isError && (
              <View
                style={[
                  styles.errorCard,
                  {
                    backgroundColor: `${colors.destructive}22`,
                    borderColor: colors.destructive,
                  },
                ]}
              >
                <Feather name="alert-circle" size={16} color={colors.destructive} />
                <Text style={[styles.errorText, { color: colors.destructive }]}>
                  {catalogQuery.error instanceof Error
                    ? catalogQuery.error.message
                    : 'Dizi kataloğu yüklenemedi.'}
                </Text>
                <TouchableOpacity onPress={() => void catalogQuery.refetch()}>
                  <Text style={[styles.retryText, { color: colors.destructive }]}>
                    Tekrar dene
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {catalogQuery.isLoading && catalogItems.length === 0 && (
              <View style={styles.catalogLoading}>
                <ActivityIndicator color={colors.primary} />
                <Text style={[styles.catalogCaption, { color: colors.mutedForeground }]}>
                  Diziler yükleniyor...
                </Text>
              </View>
            )}

            {!catalogQuery.isLoading &&
              !catalogQuery.isError &&
              catalogItems.length === 0 && (
                <Text style={[styles.catalogEmpty, { color: colors.mutedForeground }]}>
                  {activeCatalogSearch
                    ? 'Bu aramayla eşleşen dizi bulunamadı.'
                    : 'Katalogda gösterilecek dizi bulunamadı.'}
                </Text>
              )}

            <View style={styles.catalogResults}>
              {catalogItems.map((item) => (
                <TouchableOpacity
                  key={item.url}
                  style={[
                    styles.catalogItem,
                    { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                  onPress={() => handleSelectCatalogItem(item)}
                  disabled={loading}
                  activeOpacity={0.75}
                >
                  {item.posterUrl ? (
                    <Image
                      source={{ uri: item.posterUrl }}
                      style={[styles.catalogPoster, { backgroundColor: colors.secondary }]}
                      resizeMode="cover"
                    />
                  ) : (
                    <View
                      style={[
                        styles.catalogPosterFallback,
                        { backgroundColor: colors.secondary },
                      ]}
                    >
                      <Feather name="film" size={20} color={colors.mutedForeground} />
                    </View>
                  )}
                  <View style={styles.catalogItemText}>
                    <Text
                      style={[styles.catalogItemTitle, { color: colors.foreground }]}
                      numberOfLines={2}
                    >
                      {item.title}
                    </Text>
                    <Text style={[styles.catalogItemMeta, { color: colors.mutedForeground }]}>
                      Bölümleri göster
                    </Text>
                  </View>
                  {loading ? (
                    <ActivityIndicator color={colors.primary} size="small" />
                  ) : (
                    <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
                  )}
                </TouchableOpacity>
              ))}
            </View>

            {catalogQuery.data?.hasMore && (
              <TouchableOpacity
                style={[
                  styles.loadMoreBtn,
                  { backgroundColor: colors.secondary, borderColor: colors.border },
                ]}
                onPress={() => setCatalogPage((currentPage) => currentPage + 1)}
                disabled={catalogQuery.isFetching}
                activeOpacity={0.75}
              >
                {catalogQuery.isFetching ? (
                  <ActivityIndicator color={colors.primary} size="small" />
                ) : (
                  <Text style={[styles.loadMoreText, { color: colors.foreground }]}>
                    Daha fazla dizi yükle
                  </Text>
                )}
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.manualLinkToggle}
              onPress={() => setManualUrlOpen((open) => !open)}
              activeOpacity={0.7}
            >
              <Feather
                name={manualUrlOpen ? 'chevron-up' : 'link'}
                size={15}
                color={colors.mutedForeground}
              />
              <Text style={[styles.manualLinkText, { color: colors.mutedForeground }]}>
                {manualUrlOpen ? 'Bağlantı alanını gizle' : 'Dizi bağlantısıyla ekle'}
              </Text>
            </TouchableOpacity>

            {manualUrlOpen && (
              <View
                style={[
                  styles.inputCard,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <Text style={[styles.label, { color: colors.mutedForeground }]}>
                  Dizi veya bölüm bağlantısı
                </Text>
                <View style={styles.inputRow}>
                  <TextInput
                    style={[
                      styles.input,
                      { color: colors.foreground, borderColor: colors.border },
                    ]}
                    value={url}
                    onChangeText={setUrl}
                    placeholder={SAMPLE_URL}
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    onSubmitEditing={() => void handleFetch()}
                    returnKeyType="search"
                  />
                  {url.length > 0 && (
                    <TouchableOpacity
                      onPress={() => {
                        setUrl('');
                        setSeries(null);
                        setError(null);
                      }}
                      style={styles.clearBtn}
                    >
                      <Feather
                        name="x-circle"
                        size={18}
                        color={colors.mutedForeground}
                      />
                    </TouchableOpacity>
                  )}
                </View>
                <TouchableOpacity
                  style={[
                    styles.fetchBtn,
                    {
                      backgroundColor: loading ? colors.secondary : colors.primary,
                      opacity: loading ? 0.7 : 1,
                    },
                  ]}
                  onPress={() => void handleFetch()}
                  disabled={loading || !url.trim()}
                  activeOpacity={0.85}
                >
                  {loading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Feather name="search" size={16} color="#fff" />
                      <Text style={styles.fetchBtnText}>Bölümleri Bul</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </>
        )}

        {/* Error */}
        {error && (
          <View
            style={[
              styles.errorCard,
              { backgroundColor: `${colors.destructive}22`, borderColor: colors.destructive },
            ]}
          >
            <Feather name="alert-circle" size={16} color={colors.destructive} />
            <Text style={[styles.errorText, { color: colors.destructive }]}>
              {error}
            </Text>
          </View>
        )}

        {/* Series info + episode list */}
        {series && (
          <View style={styles.seriesSection}>
            <TouchableOpacity
              style={styles.backToCatalog}
              onPress={() => {
                setSeries(null);
                setError(null);
              }}
              activeOpacity={0.7}
            >
              <Feather name="arrow-left" size={15} color={colors.primary} />
              <Text style={[styles.backToCatalogText, { color: colors.primary }]}>
                Dizilere dön
              </Text>
            </TouchableOpacity>
            <View style={styles.seriesHeader}>
              <View>
                <Text style={[styles.seriesTitle, { color: colors.foreground }]}>
                  {series.title}
                </Text>
                <Text style={[styles.seriesMeta, { color: colors.mutedForeground }]}>
                  Sezon {series.season} · {series.totalEpisodes} bölüm
                </Text>
              </View>
              <TouchableOpacity
                onPress={toggleAll}
                style={[styles.toggleAllBtn, { borderColor: colors.border }]}
              >
                <Text style={[styles.toggleAllText, { color: colors.primary }]}>
                  {selected.size === series.episodes.length ? 'Temizle' : 'Tümü'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Episode grid */}
            <View style={styles.episodeGrid}>
              {series.episodes.map((ep) => {
                const isSelected = selected.has(ep.num);
                const inQueue = downloads.some(
                  (d) =>
                    d.slug === series.slug &&
                    d.season === series.season &&
                    d.episodeNum === ep.num &&
                    d.status !== 'error'
                );
                return (
                  <TouchableOpacity
                    key={ep.num}
                    onPress={() => !inQueue && toggleEpisode(ep.num)}
                    activeOpacity={0.7}
                    style={[
                      styles.epChip,
                      {
                        backgroundColor: inQueue
                          ? `${colors.success}22`
                          : isSelected
                          ? colors.primary
                          : colors.secondary,
                        borderColor: inQueue
                          ? colors.success
                          : isSelected
                          ? colors.primary
                          : 'transparent',
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.epChipText,
                        {
                          color: inQueue
                            ? colors.success
                            : isSelected
                            ? '#fff'
                            : colors.mutedForeground,
                        },
                      ]}
                    >
                      {inQueue ? '✓' : ''} {ep.num}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Download button */}
            {selected.size > 0 && (
              <TouchableOpacity
                style={[styles.downloadBtn, { backgroundColor: colors.primary }]}
                onPress={handleDownload}
                activeOpacity={0.85}
              >
                <Feather name="download" size={18} color="#fff" />
                <Text style={styles.downloadBtnText}>
                  {selected.size === 1
                    ? '1 Bölümü İndir'
                    : `${selected.size} Bölümü İndir`}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={{ height: 100 + (Platform.OS === 'web' ? 34 : insets.bottom) }} />
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 12,
  },
  logo: {
    fontSize: 28,
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
  },
  headerSub: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  badge: {
    marginLeft: 'auto',
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontFamily: 'Inter_700Bold',
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 8 },

  inputCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 10,
    marginBottom: 12,
  },
  catalogSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  catalogSearchInput: {
    flex: 1,
    height: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  catalogSearchBtn: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catalogCaption: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'Inter_400Regular',
  },
  catalogLoading: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 24,
  },
  catalogEmpty: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    paddingVertical: 18,
  },
  catalogResults: {
    gap: 8,
    marginBottom: 10,
  },
  catalogItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    padding: 10,
  },
  catalogPoster: {
    width: 48,
    height: 64,
    borderRadius: 8,
  },
  catalogPosterFallback: {
    width: 48,
    height: 64,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catalogItemText: {
    flex: 1,
    gap: 5,
  },
  catalogItemTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontFamily: 'Inter_600SemiBold',
  },
  catalogItemMeta: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  loadMoreBtn: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  loadMoreText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  manualLinkToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingVertical: 8,
    marginBottom: 10,
  },
  manualLinkText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  retryText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  label: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  inputRow: {
    position: 'relative',
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    paddingRight: 40,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  clearBtn: {
    position: 'absolute',
    right: 12,
    top: 13,
  },
  fetchBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  fetchBtnText: {
    color: '#fff',
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
  },
  errorCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  errorText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    flex: 1,
  },
  seriesSection: {
    gap: 14,
    marginBottom: 12,
  },
  backToCatalog: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingVertical: 4,
  },
  backToCatalogText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  seriesHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  seriesTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    marginBottom: 2,
  },
  seriesMeta: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  toggleAllBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  toggleAllText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  episodeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  epChip: {
    width: 52,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  epChipText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  downloadBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  downloadBtnText: {
    color: '#fff',
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  hint: {
    alignItems: 'center',
    paddingTop: 48,
    gap: 12,
  },
  hintTitle: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    marginTop: 8,
  },
  hintSub: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  sampleBtn: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sampleBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
});
