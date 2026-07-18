import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

const STORAGE_KEY = 'save_folder_uri';

export function useSaveFolder() {
  const [folderUri, setFolderUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => setFolderUri(v))
      .finally(() => setLoading(false));
  }, []);

  const selectFolder = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return false;
    try {
      const result =
        await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (result.granted) {
        await AsyncStorage.setItem(STORAGE_KEY, result.directoryUri);
        setFolderUri(result.directoryUri);
        return true;
      }
    } catch {}
    return false;
  }, []);

  const clearFolder = useCallback(async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
    setFolderUri(null);
  }, []);

  /**
   * Copy a file from the app's private storage to the chosen SAF folder.
   * Returns true on success, false on failure (e.g. file too large for base64).
   */
  const copyToSaveFolder = useCallback(
    async (srcPath: string, fileName: string, mimeType = 'video/mp4'): Promise<boolean> => {
      if (Platform.OS !== 'android' || !folderUri) return false;
      try {
        const destUri = await FileSystem.StorageAccessFramework.createFileAsync(
          folderUri,
          fileName,
          mimeType,
        );
        const content = await FileSystem.readAsStringAsync(srcPath, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await FileSystem.StorageAccessFramework.writeAsStringAsync(
          destUri,
          content,
          { encoding: FileSystem.EncodingType.Base64 },
        );
        return true;
      } catch {
        return false;
      }
    },
    [folderUri],
  );

  return { folderUri, loading, selectFolder, clearFolder, copyToSaveFolder };
}
