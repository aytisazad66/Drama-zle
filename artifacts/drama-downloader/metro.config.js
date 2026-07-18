const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// pnpm symlink support
config.resolver = config.resolver ?? {};
config.resolver.unstable_enableSymlinks = true;
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.watchFolders = [workspaceRoot];

// react-native-reanimated ve react-native-worklets pre-built JS'lerinde
// private class fields (#x) kullanıyor. Development build'deki Hermes bunu
// desteklemediği için Metro'nun Babel'dan geçirmesi gerekiyor.
// Sadece bu 2 paketi hedef alıyoruz, başka hiçbir şeye dokunmuyoruz.
config.transformer = config.transformer ?? {};
config.transformer.transformIgnorePatterns = [
  'node_modules/(?!(react-native-reanimated|react-native-worklets)/)',
];

module.exports = config;
