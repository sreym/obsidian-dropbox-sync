import {Dropbox} from "dropbox";

export async function* traverseListFolder(dbx: Dropbox, cursor: string) {
    let result;
    do {
        result = (await dbx.filesListFolderContinue({cursor})).result;
        yield result;
    } while (result.has_more);
}