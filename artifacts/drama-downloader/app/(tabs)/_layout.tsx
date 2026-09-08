import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useColors } from '@/hooks/useColors';
import { useDownloads } from '@/context/DownloadContext';

export default function TabLayout() {
  const colors = useColors();
  const { downloads } = useDownloads();
  const isIOS = Platform.OS === 'ios';
  const isWeb = Platform.OS === 'web';

  const activeCount = downloads.filter(
    (d) =>
      d.status === 'queued' ||
      d.status === 'extracting'
  ).length;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        headerShown: false,
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: isIOS ? 'transparent' : colors.card,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          elevation: 0,
          height: isWeb ? 84 : 68,
        },
        tabBarBackground: () =>
          isIOS ? (
            <BlurView
              intensity={80}
              tint="dark"
              style={StyleSheet.absoluteFill}
            />
          ) : null,
        tabBarLabelStyle: {
          fontFamily: 'Inter_500Medium',
          fontSize: 11,
          marginBottom: isWeb ? 8 : 4,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'İndir',
          tabBarIcon: ({ color, size }) => (
            <Feather name="home" size={size ?? 22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="downloads"
        options={{
          title: 'Kuyruk',
          tabBarBadge: activeCount > 0 ? activeCount : undefined,
          tabBarBadgeStyle: {
            backgroundColor: colors.primary,
            fontSize: 11,
            fontFamily: 'Inter_700Bold',
          },
          tabBarIcon: ({ color, size }) => (
            <Feather name="download" size={size ?? 22} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
