import * as cp from 'child_process';
import * as fse from 'fs-extra';
import * as os from 'os';

import { exec, spawn } from 'child_process';
import {
  join, dirname, normalize, relative,
} from './path';
import { MB1 } from './common';

const AggregateError = require('es-aggregate-error');
const drivelist = require('drivelist');

class StacklessError extends Error {
  constructor(...args) {
    super(...args);
    this.name = this.constructor.name;
    delete this.stack;
  }
}

export enum FILESYSTEM {
  APFS = 1,
  HFS_PLUS = 2,
  REFS = 3,
  NTFS = 4,
  FAT32 = 5,
  FAT16 = 6,
  OTHER = 7
}

export class Drive {
  displayName: string;

  filesystem: FILESYSTEM;

  constructor(displayName: string, filesystem: FILESYSTEM) {
    this.displayName = displayName;
    this.filesystem = filesystem;
  }
}

export namespace unix {

/**
 * Possible file lock types on a given file. This are the extracted
 * information from a `man lsof` converted into an enum.
 */
export enum LOCKTYPE {
  NFS_LOCK = 'N', // for a Solaris NFS lock of unknown type
  READ_LOCK_FILE_PART = 'r', // for read lock on part of the file
  READ_LOCK_FILE = 'R', // for a read lock on the entire file
  WRITE_LOCK_FILE_PART = 'w', // for a write lock on part of the file
  WRITE_LOCK_FILE = 'W', // for a write lock on the entire file
  READ_WRITE_LOCK_FILE = 'u', // for a read and write lock of any length
  UNKNOWN = 'X' // An unknown lock type (U, x or X)
}

export class FileHandle {
  /** PID of process which acquired the file handle */
  pid: string;

  processname: string;

  /** File access information with file lock info */
  lockType: LOCKTYPE;

  /** Documents filepath */
  filepath: string;
}

export async function whichFilesInDirAreOpen(dirpath: string): Promise<Map<string, FileHandle[]>> {
  try {
    return new Promise<Map<string, FileHandle[]>>((resolve, reject) => {
      const p0 = cp.spawn('lsof', ['-X', '-F', 'pcan', '+D', dirpath]);
      const p = new Map<string, FileHandle[]>();

      let stdout = '';
      p0.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      function parseStdout(stdout: string) {
        let lsofEntry: FileHandle = new FileHandle();
        for (const pline of stdout.split(/\n/)) {
          if (pline.startsWith('p')) { // PID of process which acquired the file handle
            // first item, therefore it creates the file handle
            lsofEntry = new FileHandle();
            lsofEntry.pid = pline.substr(1, pline.length - 1);
          } else if (pline.startsWith('c')) { // Name of process which acquired the file handle
            lsofEntry.processname = pline.substr(1, pline.length - 1);
          } else if (pline.startsWith('a')) { // File access information with file lock info
            // See `LOCKTYPE` for more information
            if (pline.includes('N')) {
              lsofEntry.lockType = LOCKTYPE.NFS_LOCK;
            } else if (pline.includes('r')) {
              lsofEntry.lockType = LOCKTYPE.READ_LOCK_FILE_PART;
            } else if (pline.includes('R')) {
              lsofEntry.lockType = LOCKTYPE.READ_LOCK_FILE;
            } else if (pline.includes('w')) {
              lsofEntry.lockType = LOCKTYPE.WRITE_LOCK_FILE_PART;
            } else if (pline.includes('W')) {
              lsofEntry.lockType = LOCKTYPE.WRITE_LOCK_FILE;
            } else if (pline.includes('u')) {
              lsofEntry.lockType = LOCKTYPE.READ_WRITE_LOCK_FILE;
            } else {
              lsofEntry.lockType = LOCKTYPE.UNKNOWN;
            }
          } else if (pline.startsWith('n')) { // Documents filepath
            const absPath = pline.substr(1, pline.length - 1);
            if (absPath.startsWith(dirpath)) {
              const relPath = relative(dirpath, pline.substr(1, pline.length - 1));
              const q = p.get(relPath);
              if (q) {
                // if there was an entry before, add the new entry to the array in the map
                q.push(lsofEntry);
              } else {
                // ..otherwise add a new list with the lsofEntry as the first element
                p.set(relPath, [lsofEntry]);
              }
              lsofEntry = new FileHandle();
            } else {
              console.log(`lsof reported unknown path: ${absPath}`);
            }
          }
        }
      }

      p0.on('exit', (code) => {
        if (code === 1) { // lsof returns 1
          parseStdout(stdout);
          resolve(p);
        } else {
          reject(code);
        }
      });
    });
  } catch (error) {
    console.log(error);
    return new Map();
  }
}

}

function getFilesystem(drive: any, mountpoint: string) {
  try {
    if (process.platform === 'win32') {
      return new Promise<string | null>((resolve, _reject) => {
        const driveLetter = mountpoint.endsWith('\\') ? mountpoint.substring(0, mountpoint.length - 1) : mountpoint;
        exec(`fsutil fsinfo volumeinfo ${driveLetter}`, (error, stdout, _stderr) => {
          if (error) {
            return resolve(null); // if we can't extract the volume info, we simply skip the ReFS detection
          }

          const lines = stdout.replace(/\r\n/g, '\r').replace(/\n/g, '\r').split(/\r/);
          for (const line of lines) {
            if (line.startsWith('File System Name :')) {
              const filesystem: string = line.split(':', 2)[1].trim();
              return resolve(filesystem);
            }
          }
          return resolve(null);
        });
      }).then((filesystem: string | null) => {
        if (filesystem) {
          // eslint-disable-next-line default-case
          switch (filesystem.toLowerCase()) {
            case 'refs':
              return FILESYSTEM.REFS;
            case 'ntfs':
              return FILESYSTEM.NTFS;
            case 'fat16':
              return FILESYSTEM.FAT16;
            case 'fat32':
            case 'fat':
              return FILESYSTEM.FAT32;
          }
        }
        return FILESYSTEM.OTHER;
      }).catch((error) => {
        console.log(error);
        return FILESYSTEM.OTHER;
      });
    }
    if (process.platform === 'darwin') {
      const isApfs: boolean = (drive.description === 'AppleAPFSMedia');
      if (isApfs) {
        return FILESYSTEM.APFS;
      }
    }
  } catch (error) {
    return FILESYSTEM.OTHER;
  }

  return FILESYSTEM.OTHER;
}

/**
 * Class to be instantiated to speedup certain I/O operations by acquiring information
 * about all connected storage devices when initialized with [[IoContext.init]].
 * In this case, [[IoContext.CopyFile]] can make use of some optimizations by checking
 * if `src` and `dst` are both on a similar APFS or ReFS storage device to use block cloning
 * operations.
 *
 * ```
 * const ioContext = new IoContext();
 * ioContext.init().then(() => {
 *     // perform many I/O operations here
 *     return io.copyFile(..);
 * });
 * ```
 */
export class IoContext {
  /** Path to the trash executable (e.g. 'recycle-bin.exe', 'trash', ...)
   * of the currently active system. If undefined or null the path is guessed.
   */
  private static trashExecPath?: string;

  /** Original returned object from `drivelist` */
  origDrives: any;

  /** Map of drive objects with mountpoints as the key */
  drives: Map<string, Drive>;

  /**
   * `true` after [[IoContext.init]] got called, `false`
   * before [[IoContext.init]] and after [[IoContext.invalidate]]
   */
  valid: boolean;

  /** Set of all known mountpoints. Set after [[IoContext.init]] is called */
  mountpoints: Set<string>;

  constructor() {
    this.valid = false;
  }

  /**
   * Invalidates the internal device storage information.
   * Normally not needed to explicitly call.
   */
  invalidate(): void {
    this.valid = false;
    this.mountpoints = undefined;
  }

  checkIfInitialized(): void {
    if (!this.valid) {
      throw new Error('IoContext is not initialized, did you forget to call IoContext.init(..)?');
    }
  }

  /**
   * In some cases the helper processes, which are used in `IoContext.putToTrash` to move a file
   * to the recycle-bin/trash are located in a different location. If that is the case, pass
   * the path of the executable.
   * @param execPath  Path to the executable. Fails if the file does not exist or the path is a directory.
   */
  static setTrashExecPath(execPath: string): void {
    if (!fse.pathExistsSync(execPath)) {
      throw new Error(`path ${execPath} does not exist`);
    }
    if (fse.statSync(execPath).isDirectory()) {
      throw new Error(`path ${execPath} must not be a directory`);
    }
    IoContext.trashExecPath = execPath;
  }

  init(): Promise<void> {
    const tmpDrives = [];
    return drivelist.list().then((drives: any) => {
      this.origDrives = drives;
      this.mountpoints = new Set();
      this.drives = new Map();

      for (const drive of drives) {
        for (const mountpoint of drive.mountpoints) {
          if (mountpoint && !mountpoint.path.startsWith('/System/')) {
            this.mountpoints.add(normalize(mountpoint.path));
          }
        }
      }

      const promises = [];

      for (const drive of drives) {
        for (const mountpoint of drive.mountpoints) {
          promises.push(getFilesystem(drive, normalize(mountpoint.path)));
          tmpDrives.push([normalize(mountpoint.path), mountpoint.label]);
        }
      }
      return Promise.all(promises);
    }).then((res: FILESYSTEM[]) => {
      let i = 0;
      res.forEach((filesystem: FILESYSTEM) => {
        if (!tmpDrives[i][0].startsWith('/System/')) {
          this.drives.set(tmpDrives[i][0], new Drive(tmpDrives[i][1], filesystem));
        }
        i++;
      });
    }).then(() => {
      this.valid = true;
    });
  }

  /**
   * Check if two filepaths are pointing to the same storage device.
   * @param file0     First filepath.
   * * @param file1   Second filepath.
   */
  areFilesOnSameDrive(file0: string, file1: string): boolean {
    this.checkIfInitialized();

    // detect if src and dst are copied onto the same drive
    let i = 0; let
      j = 0;
    this.mountpoints.forEach((mountpoint: string) => {
      if (file0.startsWith(mountpoint)) {
        i++;
      }
      if (file1.startsWith(mountpoint)) {
        j++;
      }
    });

    return i === j;
  }

  private copyFileApfs(src: string, dst: string): Promise<void> {
    return fse.stat(src).then((stat: fse.Stats) => {
      // TODO: (Need help)
      // It seems on APFS copying files smaller than 1MB is faster than using COW.
      // Could be a local hickup on my system, verification/citation needed
      if (stat.size < MB1) {
        return fse.copyFile(src, dst, fse.constants.COPYFILE_FICLONE);
      }

      const p0 = cp.spawn('cp', ['-c', src, dst]);
      return new Promise((resolve, reject) => {
        p0.on('exit', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(code);
          }
        });
      });
    });
  }

  private copyFileRefs(src: string, dst: string): Promise<void> {
    return fse.stat(src).then((stat: fse.Stats) => {
      if (stat.size < MB1) {
        return fse.copyFile(src, dst, fse.constants.COPYFILE_FICLONE);
      }

      let cloneFileViaBlockClonePs1 = 'Clone-FileViaBlockClone.ps1';
      if (fse.pathExistsSync(join(dirname(process.execPath), 'resources', cloneFileViaBlockClonePs1))) {
        cloneFileViaBlockClonePs1 = join(dirname(process.execPath), 'resources', cloneFileViaBlockClonePs1);
      } else if (fse.pathExistsSync(join(__dirname, '..', 'resources', cloneFileViaBlockClonePs1))) {
        cloneFileViaBlockClonePs1 = join(__dirname, '..', 'resources', cloneFileViaBlockClonePs1);
      } else {
        console.warn(`unable to locate ${cloneFileViaBlockClonePs1}, fallback to fse.copyFile(..)`);
        return fse.copyFile(src, dst, fse.constants.COPYFILE_FICLONE);
      }

      const p0 = cp.spawn('powershell.exe', [cloneFileViaBlockClonePs1, src, dst]);
      return new Promise((resolve, reject) => {
        p0.stdout.on('data', (data) => console.log(data.toString()));
        p0.stderr.on('data', (data) => console.log(data.toString()));
        p0.on('exit', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(code);
          }
        });
      });
    });
  }

  /**
   * Asynchronously copies `src` to `dest`. By default, `dest` is overwritten if it already exists.
   * The Promise will be resolved with no arguments upon success.
   *
   * Node.js makes no guarantees about the atomicity of the copy operation. If an error occurs after
   * the destination file has been opened for writing, Node.js will attempt to remove the destination.
   *
   * @param src   source filename to copy
   * @param dst   destination filename of the copy operation
   */
  copyFile(src: string, dst: string): Promise<void> {
    this.checkIfInitialized();
    const srcAndDstOnSameDrive = this.areFilesOnSameDrive(src, dst);
    let filesystem = FILESYSTEM.OTHER;
    if (srcAndDstOnSameDrive) {
      // find the mountpoint again to extract filesystem info
      for (const mountpoint of Array.from(this.mountpoints)) {
        if (src.startsWith(mountpoint)) {
          filesystem = this.drives.get(mountpoint).filesystem;
          break;
        }
      }
    }

    switch (process.platform) {
      case 'darwin':
        if (srcAndDstOnSameDrive && filesystem === FILESYSTEM.APFS) {
          return this.copyFileApfs(src, dst);
        }
        /* falls through */
      case 'win32':
        if (srcAndDstOnSameDrive && filesystem === FILESYSTEM.REFS) {
          return this.copyFileRefs(src, dst);
        }
        /* falls through */
      case 'linux':
        // The copy operation will attempt to create a copy-on-write reflink.
        // If the platform does not support copy-on-write, then a fallback copy mechanism is used.
        return fse.copyFile(src, dst, fse.constants.COPYFILE_FICLONE);
      default:
        throw new Error('Unsupported Operating System');
    }
  }

  /**
   * Check if the given filepaths are write-locked by another process.
   * For more information, or to add comments visit https://github.com/Snowtrack/SnowFS/discussions/110
   *
   * @param dir               The root directory path to check
   * @param relPaths          Relative file paths inside the given directory.
   * @throws {AggregateError} Aggregated error of StacklessError
   */
  performWriteLockChecks(dir: string, relPaths: string[]): Promise<void> {
    function checkWin32(relPaths): Promise<void> {
      const absPaths = relPaths.map((p: string) => join(dir, p));

      const promises = [];

      for (const absPath of absPaths) {
        promises.push(fse.stat(absPath));
      }

      const stats1 = new Map<string, number>();

      return Promise.all(promises)
        .then((stats: fse.Stats[]) => {
          if (stats.length !== relPaths.length) {
            throw new Error('Internal error: stats != paths');
          }

          for (let i = 0; i < relPaths.length; ++i) {
            stats1.set(relPaths[i], stats[i].size);
          }

          return new Promise<void>((resolve) => {
            setTimeout(() => {
              resolve();
            }, 500);
          });
        }).then(() => {
          const promises = [];

          for (const absPath of absPaths) {
            promises.push(fse.stat(absPath));
          }

          return Promise.all(promises);
        }).then((stats: fse.Stats[]) => {
          if (stats.length !== relPaths.length) {
            throw new Error('Internal error: stats != paths');
          }

          const errors: Error[] = [];

          for (let i = 0; i < relPaths.length; ++i) {
            const prevSize = stats1.get(relPaths[i]);
            if (prevSize !== stats[i].size) {
              const msg = `File '${relPaths[i]}' is written by another process`;
              errors.push(new StacklessError(msg));
            }
          }

          if (errors.length > 0) {
            throw new AggregateError(errors);
          }
        });
    }

    function checkUnixLike(relPaths): Promise<void> {
      return unix.whichFilesInDirAreOpen(dir)
        .then((fileHandles: Map<string, unix.FileHandle[]>) => {
          const errors: Error[] = [];

          for (const relPath of relPaths) {
            const fhs: unix.FileHandle[] = fileHandles.get(relPath);
            if (fhs) {
              for (const fh of fhs) {
                if (fh.lockType === unix.LOCKTYPE.READ_WRITE_LOCK_FILE
                    || fh.lockType === unix.LOCKTYPE.WRITE_LOCK_FILE
                    || fh.lockType === unix.LOCKTYPE.WRITE_LOCK_FILE_PART) {
                  const msg = `File '${relPath}' is written by ${fh.processname ?? 'another process'}`;
                  errors.push(new StacklessError(msg));
                }
              }
            }
          }

          if (errors.length > 0) {
            throw new AggregateError(errors);
          }
        });
    }

    switch (process.platform) {
      case 'win32':
        return checkWin32(relPaths);
      case 'darwin':
      case 'linux':
        return checkUnixLike(relPaths);
      default:
        throw new Error('Unknown operating system');
    }
  }

  /**
   * Move a file into the trash of the operating system. `SnowFS` tends to avoid
   * destructive delete operations at all costs, and rather moves files into the trash.
   *
   * @param path        The file to move to the trash.
   * @param execPath    If `SnowFS` is embedded in another application, the resource path
   *                    might be located somewhere else. Can be set so `SnowFS` can find
   *                    the executables.
  */
  static putToTrash(path: string): Promise<void> {
    let trashPath: string = IoContext.trashExecPath;
    if (!trashPath) {
      switch (process.platform) {
        case 'darwin': {
          if (fse.pathExistsSync(join(dirname(process.execPath), 'resources', 'trash'))) {
            trashPath = join(dirname(process.execPath), 'resources', 'trash');
          } else if (fse.pathExistsSync(join(__dirname, '..', 'resources', 'trash'))) {
            trashPath = join(__dirname, '..', 'resources', 'trash');
          } else {
            throw new Error('unable to locate trash executable');
          }
          break;
        }
        case 'win32': {
          if (fse.pathExistsSync(join(dirname(process.execPath), 'resources', 'recycle-bin.exe'))) {
            trashPath = join(dirname(process.execPath), 'resources', 'recycle-bin.exe');
          } else if (fse.pathExistsSync(join(__dirname, '..', 'resources', 'recycle-bin.exe'))) {
            trashPath = join(__dirname, '..', 'resources', 'recycle-bin.exe');
          } else {
            throw new Error('unable to locate trash executable');
          }
          break;
        }
        default: {
          throw new Error('Unknown operating system');
        }
      }
    }

    switch (process.platform) {
      case 'darwin': {
        const isOlderThanMountainLion = Number(os.release().split('.')[0]) < 12;
        if (isOlderThanMountainLion) {
          throw new Error('macOS 10.12 or later required');
        }
        break;
      }
      case 'win32': {
        break;
      }
      default: {
        throw new Error('Unknown operating system');
      }
    }

    return fse.pathExists(path)
      .then((exists: boolean) => {
        if (!exists) {
          throw new Error(`${path} no such file or directory`);
        }

        return new Promise((resolve, reject) => {
          const proc = spawn(trashPath, [path]);

          proc.on('exit', (code: number) => {
            if (code === 0) {
              resolve();
            } else {
              const stderr = proc.stderr.read();
              if (stderr) {
                reject(stderr.toString());
              } else {
                reject(code);
              }
            }
          });
        });
      });
  }
}
