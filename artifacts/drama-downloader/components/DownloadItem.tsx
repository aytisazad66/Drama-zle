import React from 'react';
import {
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';

import { useColors } from '@/hooks/useColors';
import type { DownloadItem as DownloadItemType } from '@/context/DownloadContext';

interface Props {
  item: DownloadItemType;
  onCancel: () => void;
}

export default function DownloadItemCard({ item, onCancel }: Props) {
  const colors = useColors();

  const statusColor = {
    queued: colors.mutedForeground,
    extracting: colors.warning,
    uploading: colors.primary,
    done: colors.success,
    error: colors.destructive,
  }[item.status];

  const statusLabel = {
    queued: 'Kuyrukta',
    extracting: 'Link çekiliyor...',
    uploading: 'Stream\'e yükleniyor...',
    done: 'Stream\'e yüklendi ✓',
    error: item.error ?? 'Hata',
  }[item.status];

  const progressPercent =
    item.status === 'uploading'
      ? 60  // indeterminate — show partial fill
      : item.status === 'done'
      ? 100
      : 0;

  const handleWatch = () => {
    if (item.cfStreamUid) {
      // Opens CF Stream's hosted player in the device browser
      Linking.openURL(`https://watch.cloudflarestream.com/${item.cfStreamUid}`);
    } else if (item.cfStreamUrl) {
      Linking.openURL(item.cfStreamUrl);
    }
  };

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={[styles.epBadge, { backgroundColor: colors.secondary }]}>
            <Text style={[styles.epText, { color: colors.primary }]}>
              E{item.episodeNum}
            </Text>
          </View>
          <View style={styles.titleBlock}>
            <Text
              style={[styles.title, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {item.seriesTitle}
            </Text>
            <Text style={[styles.meta, { color: colors.mutedForeground }]}>
              Sezon {item.season} · Bölüm {item.episodeNum}
            </Text>
          </View>
        </View>

        <View style={styles.actions}>
          {(item.status === 'queued' ||
            item.status === 'uploading' ||
            item.status === 'extracting') && (
            <TouchableOpacity onPress={onCancel} style={styles.iconBtn}>
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Progress bar */}
      <View style={[styles.progressTrack, { backgroundColor: colors.secondary }]}>
        <View
          style={[
            styles.progressFill,
            {
              width: `${progressPercent}%` as any,
              backgroundColor:
                item.status === 'error' ? colors.destructive : statusColor,
            },
          ]}
        />
      </View>

      {/* Status row */}
      <View style={styles.statusRow}>
        <Text style={[styles.statusText, { color: statusColor }]}>
          {statusLabel}
        </Text>
        {item.status === 'done' && item.cfStreamUid && (
          <Text style={[styles.uidText, { color: colors.mutedForeground }]}>
            {item.cfStreamUid.slice(0, 8)}…
          </Text>
        )}
      </View>

      {/* Watch button — shown when upload is complete */}
      {item.status === 'done' && (item.cfStreamUid || item.cfStreamUrl) && (
        <TouchableOpacity
          onPress={handleWatch}
          style={[styles.watchBtn, { backgroundColor: colors.primary }]}
          activeOpacity={0.8}
        >
          <Feather name="play-circle" size={15} color="#fff" />
          <Text style={styles.watchBtnText}>Stream'de İzle</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 10,
  },
  epBadge: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  epText: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  titleBlock: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    marginBottom: 2,
  },
  meta: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  actions: {
    flexDirection: 'row',
    gap: 6,
  },
  iconBtn: {
    padding: 6,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusText: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  uidText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  watchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  watchBtnText: {
    color: '#fff',
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
});
