import * as fse from 'fs-extra';
import { Result } from './common';

export class IgnoreManager {
    ignores: RegExp[];

    includes: RegExp[];

    async init(filepath: string) : Promise<Result<void>> {
      this.ignores = [];
      this.includes = [];

      return fse.readFile(filepath).then((value: Buffer) => {
        const lines: string[] = value.toString().split('\n');
        for (let line of lines) {
          line = line.trim();
          if (line.length > 0 && !line.startsWith('//')) {
            line = line.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ''); // remove /* comment */ or // comment
            line = line.replace('\\', '/'); // windows dir seperator char

            const except = line.startsWith('!');
            if (except) {
              line = line.substr(1, line.length - 1);
            }

            const regexStr = line.replace(/\*/, '[\\w/]*');
            let regex : RegExp;
            try {
              regex = new RegExp(regexStr);
            } catch (error) {
              return { success: false, error: `Invalid Expression in ignore file: ${line}`, value: null };
            }

            if (except) {
              this.includes.push(regex);
            } else {
              this.ignores.push(regex);
            }
          }
        }

        return { success: true, error: '', value: null };
      });
    }

    ignored(filepath: string): boolean {
      for (const ignore of this.ignores) {
        if (ignore.exec(filepath)) {
          let keep: boolean = false;
          for (const include of this.includes) {
            if (include.exec(filepath)) {
              keep = true;
              break;
            }
          }
          if (keep) {
            continue;
          } else {
            return true;
          }
        }
      }
      return false;
    }
}
