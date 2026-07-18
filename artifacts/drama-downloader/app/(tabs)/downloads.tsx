import React, { useMemo } from 'react';
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useDownloads } from '@/context/DownloadContext';
import DownloadItemCard from '@/components/DownloadItem';

export default function DownloadsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { downloads, cancelDownload, clearCompleted, clearAll } = useDownloads();

  const sorted = useMemo(
    () => [...downloads].sort((a, b) => a.addedAt - b.addedAt),
    [downloads]
  );

  const active = sorted.filter(
    (d) =>
      d.status === 'queued' ||
      d.status === 'uploading' ||
      d.status === 'extracting'
  );
  const done = sorted.filter((d) => d.status === 'done');
  const failed = sorted.filter((d) => d.status === 'error');

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;

  if (downloads.length === 0) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { paddingTop: topPad + 16 }]}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            Yüklemeler
          </Text>
        </View>
        <View style={styles.emptyState}>
          <Feather name="upload-cloud" size={48} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            Henüz yükleme yok
          </Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            Ana sayfadan bir dizi URL'i girerek{'\n'}bölümleri Cloudflare Stream'e yükle.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad + 16 }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          Yüklemeler
        </Text>
        <View style={styles.headerActions}>
          {done.length > 0 && (
            <TouchableOpacity
              onPress={clearCompleted}
              style={[styles.actionBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.actionBtnText, { color: colors.mutedForeground }]}>
                Tamamlananları sil
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Stats bar */}
      <View style={[styles.statsBar, { backgroundColor: colors.card }]}>
        <StatChip label="Kuyruk" value={active.length} color={colors.primary} colors={colors} />
        <StatChip label="Bitti" value={done.length} color={colors.success} colors={colors} />
        <StatChip label="Hata" value={failed.length} color={colors.destructive} colors={colors} />
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: bottomPad + 100 },
        ]}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <DownloadItemCard
            item={item}
            onCancel={() => cancelDownload(item.id)}
          />
        )}
        ListHeaderComponent={
          active.length > 0 ? (
            <View style={styles.sectionLabel}>
              <View style={[styles.dot, { backgroundColor: colors.primary }]} />
              <Text style={[styles.sectionLabelText, { color: colors.mutedForeground }]}>
                Aktif yüklemeler
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}

function StatChip({
  label,
  value,
  color,
  colors,
}: {
  label: string;
  value: number;
  color: string;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.statChip}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  actionBtnText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  statsBar: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 14,
    padding: 14,
    gap: 0,
  },
  statChip: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    marginBottom: 2,
  },
  statLabel: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  sectionLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  sectionLabelText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingBottom: 80,
  },
  emptyTitle: {
    fontSize: 20,
    fontFamily: 'Inter_700Bold',
    marginTop: 8,
  },
  emptySub: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
});
