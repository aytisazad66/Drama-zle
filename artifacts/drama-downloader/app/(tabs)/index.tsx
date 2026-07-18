import React, { useState, useCallback } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useDownloads } from '@/context/DownloadContext';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<SeriesInfo | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const handleFetch = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setSeries(null);
    setSelected(new Set());

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
  }, [series, selected, addEpisodes]);

  const queuedCount = downloads.filter(
    (d) => d.status === 'queued' || d.status === 'downloading' || d.status === 'extracting'
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

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* URL Input */}
        <View style={[styles.inputCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>
            Dizi URL'i
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
              onSubmitEditing={handleFetch}
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
                <Feather name="x-circle" size={18} color={colors.mutedForeground} />
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
            onPress={handleFetch}
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

        {/* Hint when empty */}
        {!series && !loading && !error && (
          <View style={styles.hint}>
            <Feather name="film" size={40} color={colors.mutedForeground} />
            <Text style={[styles.hintTitle, { color: colors.foreground }]}>
              Dizi URL'i yapıştır
            </Text>
            <Text style={[styles.hintSub, { color: colors.mutedForeground }]}>
              dramadizilerim.com linkini yukarıya girerek{'\n'}
              tüm bölümleri tek tıkla indirebilirsin.
            </Text>
            <TouchableOpacity
              onPress={() => setUrl(SAMPLE_URL)}
              style={[styles.sampleBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.sampleBtnText, { color: colors.mutedForeground }]}>
                Örnek URL dene
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 100 + (Platform.OS === 'web' ? 34 : insets.bottom) }} />
      </ScrollView>
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
