/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const Resolver = require('metro-resolver');

const invariant = require('fbjs/lib/invariant');
const path = require('path');
const util = require('util');

import type {Moduleish, Packageish} from './ResolutionRequest';
import type {
  CustomResolver,
  DoesFileExist,
  IsAssetFile,
  ResolveAsset,
  Resolution,
} from 'metro-resolver';

export type DirExistsFn = (filePath: string) => boolean;

/**
 * `jest-haste-map`'s interface for ModuleMap.
 */
export type ModuleMap = {
  getModule(
    name: string,
    platform: string | null,
    supportsNativePlatform: ?boolean,
  ): ?string,
  getPackage(
    name: string,
    platform: string | null,
    supportsNativePlatform: ?boolean,
  ): ?string,
};

export type ModuleishCache<TModule, TPackage> = {
  getPackage(
    name: string,
    platform?: string,
    supportsNativePlatform?: boolean,
  ): TPackage,
  getModule(path: string): TModule,
};

type Options<TModule, TPackage> = {|
  +allowPnp: boolean,
  +dirExists: DirExistsFn,
  +doesFileExist: DoesFileExist,
  +extraNodeModules: ?Object,
  +isAssetFile: IsAssetFile,
  +mainFields: $ReadOnlyArray<string>,
  +moduleCache: ModuleishCache<TModule, TPackage>,
  +preferNativePlatform: boolean,
  +moduleMap: ModuleMap,
  +resolveAsset: ResolveAsset,
  +resolveRequest: ?CustomResolver,
  +sourceExts: $ReadOnlyArray<string>,
|};

class ModuleResolver<TModule: Moduleish, TPackage: Packageish> {
  _options: Options<TModule, TPackage>;

  static EMPTY_MODULE: string = require.resolve('./assets/empty-module.js');

  constructor(options: Options<TModule, TPackage>) {
    this._options = options;
  }

  _redirectRequire(fromModule: TModule, modulePath: string): string | false {
    const moduleCache = this._options.moduleCache;
    try {
      if (modulePath.startsWith('.')) {
        const fromPackage = fromModule.getPackage();

        if (fromPackage) {
          // We need to convert the module path from module-relative to
          // package-relative, so that we can easily match it against the
          // "browser" map (where all paths are relative to the package root)
          const fromPackagePath =
            './' +
            path.relative(
              path.dirname(fromPackage.path),
              path.resolve(path.dirname(fromModule.path), modulePath),
            );

          let redirectedPath = fromPackage.redirectRequire(
            fromPackagePath,
            this._options.mainFields,
          );

          // Since the redirected path is still relative to the package root,
          // we have to transform it back to be module-relative (as it
          // originally was)
          if (redirectedPath !== false) {
            redirectedPath =
              './' +
              path.relative(
                path.dirname(fromModule.path),
                path.resolve(path.dirname(fromPackage.path), redirectedPath),
              );
          }

          return redirectedPath;
        }
      } else {
        const pck = path.isAbsolute(modulePath)
          ? moduleCache.getModule(modulePath).getPackage()
          : fromModule.getPackage();

        if (pck) {
          return pck.redirectRequire(modulePath, this._options.mainFields);
        }
      }
    } catch (err) {
      // Do nothing. The standard module cache does not trigger any error, but
      // the ModuleGraph one does, if the module does not exist.
    }

    return modulePath;
  }

  resolveDependency(
    fromModule: TModule,
    moduleName: string,
    allowHaste: boolean,
    platform: string | null,
  ): TModule {
    try {
      const result = Resolver.resolve(
        {
          ...this._options,
          originModulePath: fromModule.path,
          redirectModulePath: modulePath =>
            this._redirectRequire(fromModule, modulePath),
          allowHaste,
          platform,
          resolveHasteModule: name =>
            this._options.moduleMap.getModule(name, platform, true),
          resolveHastePackage: name =>
            this._options.moduleMap.getPackage(name, platform, true),
          getPackageMainPath: this._getPackageMainPath,
        },
        moduleName,
        platform,
      );
      return this._getFileResolvedModule(result);
    } catch (error) {
      if (error instanceof Resolver.FailedToResolvePathError) {
        const {candidates} = error;
        throw new UnableToResolveError(
          fromModule.path,
          moduleName,
          [
            `The module \`${moduleName}\` could not be found from \`${
              fromModule.path
            }\`. Indeed, none of these files exist:`,
            `  * \`${Resolver.formatFileCandidates(candidates.file)}\``,
            `  * \`${Resolver.formatFileCandidates(candidates.dir)}\``,
          ].join('\n'),
        );
      }
      if (error instanceof Resolver.FailedToResolveNameError) {
        const {dirPaths, extraPaths} = error;
        const displayDirPaths = dirPaths
          .filter(dirPath => this._options.dirExists(dirPath))
          .concat(extraPaths);

        const hint = displayDirPaths.length ? ' or in these directories:' : '';
        throw new UnableToResolveError(
          fromModule.path,
          moduleName,
          [
            `Module \`${moduleName}\` does not exist in the Haste module map${hint}`,
            ...displayDirPaths.map(dirPath => `  ${path.dirname(dirPath)}`),
            '',
            'This might be related to https://github.com/facebook/react-native/issues/4968',
            'To resolve try the following:',
            '  1. Clear watchman watches: `watchman watch-del-all`.',
            '  2. Delete the `node_modules` folder: `rm -rf node_modules && npm install`.',
            '  3. Reset Metro Bundler cache: `rm -rf /tmp/metro-bundler-cache-*` or `npm start -- --reset-cache`.',
            '  4. Remove haste cache: `rm -rf /tmp/haste-map-react-native-packager-*`.',
          ].join('\n'),
        );
      }
      throw error;
    }
  }

  _getPackageMainPath = (packageJsonPath: string): string => {
    const package_ = this._options.moduleCache.getPackage(packageJsonPath);
    return package_.getMain(this._options.mainFields);
  };

  /**
   * FIXME: get rid of this function and of the reliance on `TModule`
   * altogether, return strongly typed resolutions at the top-level instead.
   */
  _getFileResolvedModule(resolution: Resolution): TModule {
    switch (resolution.type) {
      case 'sourceFile':
        return this._options.moduleCache.getModule(resolution.filePath);
      case 'assetFiles':
        // FIXME: we should forward ALL the paths/metadata,
        // not just an arbitrary item!
        const arbitrary = getArrayLowestItem(resolution.filePaths);
        invariant(arbitrary != null, 'invalid asset resolution');
        return this._options.moduleCache.getModule(arbitrary);
      case 'empty':
        const {moduleCache} = this._options;
        const module = moduleCache.getModule(ModuleResolver.EMPTY_MODULE);
        invariant(module != null, 'empty module is not available');
        return module;
      default:
        (resolution.type: empty);
        throw new Error('invalid type');
    }
  }
}

function getArrayLowestItem(a: $ReadOnlyArray<string>): string | void {
  if (a.length === 0) {
    return undefined;
  }
  let lowest = a[0];
  for (let i = 1; i < a.length; ++i) {
    if (a[i] < lowest) {
      lowest = a[i];
    }
  }
  return lowest;
}

class UnableToResolveError extends Error {
  /**
   * File path of the module that tried to require a module, ex. `/js/foo.js`.
   */
  originModulePath: string;
  /**
   * The name of the module that was required, no necessarily a path,
   * ex. `./bar`, or `invariant`.
   */
  targetModuleName: string;

  constructor(
    originModulePath: string,
    targetModuleName: string,
    message: string,
  ) {
    super();
    this.originModulePath = originModulePath;
    this.targetModuleName = targetModuleName;
    this.message = util.format(
      'Unable to resolve module `%s` from `%s`: %s',
      targetModuleName,
      originModulePath,
      message,
    );
  }
}

module.exports = {
  ModuleResolver,
  UnableToResolveError,
};
