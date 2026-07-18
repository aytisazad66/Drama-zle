import React, { useMemo } from 'react';
import {
  Alert,
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
  const { downloads, cancelDownload, clearCompleted, clearAll, saveFolderUri, selectSaveFolder, clearSaveFolder } = useDownloads();

  const handleFolderPress = async () => {
    if (Platform.OS !== 'android') return;
    if (saveFolderUri) {
      Alert.alert(
        'Kayıt Klasörü',
        'Kayıt klasörünü değiştirmek veya kaldırmak ister misiniz?',
        [
          { text: 'İptal', style: 'cancel' },
          { text: 'Değiştir', onPress: () => selectSaveFolder() },
          { text: 'Kaldır', style: 'destructive', onPress: () => clearSaveFolder() },
        ],
      );
    } else {
      await selectSaveFolder();
    }
  };

  const sorted = useMemo(
    () => [...downloads].sort((a, b) => a.addedAt - b.addedAt),
    [downloads]
  );

  const active = sorted.filter(
    (d) => d.status === 'queued' || d.status === 'downloading' || d.status === 'extracting'
  );
  const done = sorted.filter((d) => d.status === 'done');
  const failed = sorted.filter((d) => d.status === 'error');

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;

  // Folder banner shown on Android at top of both states
  const folderBanner = Platform.OS === 'android' ? (
    <TouchableOpacity
      onPress={handleFolderPress}
      style={[
        styles.folderBanner,
        { backgroundColor: saveFolderUri ? colors.success + '22' : colors.card, borderColor: saveFolderUri ? colors.success : colors.border },
      ]}
      activeOpacity={0.7}
    >
      <Feather name="folder" size={16} color={saveFolderUri ? colors.success : colors.mutedForeground} />
      <Text style={[styles.folderBannerText, { color: saveFolderUri ? colors.success : colors.mutedForeground }]} numberOfLines={1}>
        {saveFolderUri ? '✓ Klasör seçildi — videolar oraya kopyalanır' : 'Kayıt klasörü seç (örn. indirilendramalar)'}
      </Text>
      <Feather name="chevron-right" size={14} color={saveFolderUri ? colors.success : colors.mutedForeground} />
    </TouchableOpacity>
  ) : null;

  if (downloads.length === 0) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { paddingTop: topPad + 16 }]}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            İndirmeler
          </Text>
        </View>
        {folderBanner}
        <View style={styles.emptyState}>
          <Feather name="download" size={48} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            Henüz indirme yok
          </Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            Ana sayfadan bir dizi URL'i girerek{'\n'}bölümleri indirmeye başla.
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
          İndirmeler
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

      {folderBanner}

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
                Aktif indirmeler
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
  folderBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  folderBannerText: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
});
