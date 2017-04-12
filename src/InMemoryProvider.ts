﻿/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for a non-persisted in-memory database backing provider.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import FullTextSearchHelpers = require('./FullTextSearchHelpers');
import NoSqlProvider = require('./NoSqlProvider');
import NoSqlProviderUtils = require('./NoSqlProviderUtils');
import TransactionLockHelper, { TransactionToken } from './TransactionLockHelper';

export type StoreData = { data: _.Dictionary<any>, schema: NoSqlProvider.StoreSchema };

// Very simple in-memory dbprovider for handling IE inprivate windows (and unit tests, maybe?)
export class InMemoryProvider extends NoSqlProvider.DbProvider {
    private _stores: { [storeName: string]: StoreData } = {};

    private _lockHelper: TransactionLockHelper;

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        _.each(this._schema.stores, storeSchema => {
            this._stores[storeSchema.name] = { schema: storeSchema, data: {} };
        });

        this._lockHelper = new TransactionLockHelper(schema, true);

        return SyncTasks.Resolved<void>();
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): SyncTasks.Promise<NoSqlProvider.DbTransaction> {
        return this._lockHelper.openTransaction(storeNames, writeNeeded).then(token =>
            new InMemoryTransaction(this, this._lockHelper, token));
    }

    close(): SyncTasks.Promise<void> {
        return SyncTasks.Resolved<void>();
    }

    internal_getStore(name: string): StoreData {
        return this._stores[name];
    }
}

// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
class InMemoryTransaction implements NoSqlProvider.DbTransaction {
    private _openTimer: number;

    private _stores: _.Dictionary<InMemoryStore> = {};

    constructor(private _prov: InMemoryProvider, private _lockHelper: TransactionLockHelper, private _transToken: TransactionToken) {
        // Close the transaction on the next tick.  By definition, anything is completed synchronously here, so after an event tick
        // goes by, there can't have been anything pending.
        this._openTimer = setTimeout(() => {
            this._openTimer = undefined;
            this._commitTransaction();
            this._lockHelper.transactionComplete(this._transToken);
        }, 0) as any as number;
    }

    private _commitTransaction(): void {
        _.each(this._stores, store => {
            store.internal_commitPendingData();
        });
    }

    getCompletionPromise(): SyncTasks.Promise<void> {
        return this._transToken.completionPromise;
    }

    abort(): void {
        _.each(this._stores, store => {
            store.internal_rollbackPendingData();
        });
        this._stores = {};

        clearTimeout(this._openTimer);
        this._lockHelper.transactionFailed(this._transToken, 'InMemoryTransaction Aborted');
    }

    markCompleted(): void {
        // noop
    }

    getStore(storeName: string): NoSqlProvider.DbStore {
        if (!_.includes(NoSqlProviderUtils.arrayify(this._transToken.storeNames), storeName)) {
            throw new Error('Store not found in transaction-scoped store list: ' + storeName);
        }
        if (this._stores[storeName]) {
            return this._stores[storeName];
        }
        const store = this._prov.internal_getStore(storeName);
        if (!store) {
            throw new Error('Store not found: ' + storeName);
        }
        const ims = new InMemoryStore(this, store);
        this._stores[storeName] = ims;
        return ims;
    }

    internal_isOpen() {
        return !!this._openTimer;
    }
}

class InMemoryStore implements NoSqlProvider.DbStore {
    private _pendingCommitDataChanges: _.Dictionary<any>|undefined;

    private _committedStoreData: _.Dictionary<any>;
    private _mergedData: _.Dictionary<any>;
    private _storeSchema: NoSqlProvider.StoreSchema;

    constructor(private _trans: InMemoryTransaction, storeInfo: StoreData) {
        this._storeSchema = storeInfo.schema;
        this._committedStoreData = storeInfo.data;

        this._mergedData = this._committedStoreData;
    }

    private _checkDataClone(): void {
        if (!this._pendingCommitDataChanges) {
            this._pendingCommitDataChanges = {};
            this._mergedData = _.assign({}, this._committedStoreData);
        }
    }

    internal_commitPendingData(): void {
        _.each(this._pendingCommitDataChanges, (val, key) => {
            if (val === undefined) {
                delete this._committedStoreData[key];
            } else {
                this._committedStoreData[key] = val;
            }
        });

        this._pendingCommitDataChanges = undefined;
        this._mergedData = this._committedStoreData;
    }

    internal_rollbackPendingData(): void {
        this._pendingCommitDataChanges = undefined;
        this._mergedData = this._committedStoreData;
    }

    get<T>(key: any | any[]): SyncTasks.Promise<T> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }

        let joinedKey: string;
        const err = _.attempt(() => {
            joinedKey = NoSqlProviderUtils.serializeKeyToString(key, this._storeSchema.primaryKeyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        return SyncTasks.Resolved(this._mergedData[joinedKey]);
    }

    getMultiple<T>(keyOrKeys: any | any[]): SyncTasks.Promise<T[]> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }

        let joinedKeys: string[];
        const err = _.attempt(() => {
            joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        return SyncTasks.Resolved(_.compact(_.map(joinedKeys, key => this._mergedData[key])));
    }

    put(itemOrItems: any | any[]): SyncTasks.Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        const err = _.attempt(() => {
            _.each(NoSqlProviderUtils.arrayify(itemOrItems), item => {
                let pk = NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._storeSchema.primaryKeyPath);

                this._pendingCommitDataChanges[pk] = item;
                this._mergedData[pk] = item;
            });
        });
        if (err) {
            return SyncTasks.Rejected<void>(err);
        }
        return SyncTasks.Resolved<void>();
    }

    remove(keyOrKeys: any | any[]): SyncTasks.Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();

        let joinedKeys: string[];
        const err = _.attempt(() => {
            joinedKeys = NoSqlProviderUtils.formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (err) {
            return SyncTasks.Rejected<void>(err);
        }

        _.each(joinedKeys, key => {
            this._pendingCommitDataChanges[key] = undefined;
            delete this._mergedData[key];
        });
        return SyncTasks.Resolved<void>();
    }

    openPrimaryKey(): NoSqlProvider.DbIndex {
        this._checkDataClone();
        return new InMemoryIndex(this._trans, this._mergedData, undefined, this._storeSchema.primaryKeyPath);
    }

    openIndex(indexName: string): NoSqlProvider.DbIndex {
        let indexSchema = _.find(this._storeSchema.indexes, idx => idx.name === indexName);
        if (!indexSchema) {
            return undefined;
        }

        this._checkDataClone();
        return new InMemoryIndex(this._trans, this._mergedData, indexSchema, this._storeSchema.primaryKeyPath);
    }

    clearAllData(): SyncTasks.Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        _.each(this._mergedData, (val, key) => {
            this._pendingCommitDataChanges[key] = undefined;
        });
        this._mergedData = {};
        return SyncTasks.Resolved<void>();
    }
}

// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
class InMemoryIndex extends FullTextSearchHelpers.DbIndexFTSFromRangeQueries {
    constructor(private _trans: InMemoryTransaction, private _mergedData: _.Dictionary<any>, indexSchema: NoSqlProvider.IndexSchema,
            primaryKeyPath: string | string[]) {
        super(indexSchema, primaryKeyPath);
    }

    // Warning: This function can throw, make sure to trap.
    private _calcChunkedData(): _.Dictionary<any> {
        if (!this._indexSchema) {
            // Primary key -- use data intact
            return this._mergedData;
        }

        // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
        let data: _.Dictionary<any> = {};
        _.each(this._mergedData, item => {
            // Each item may be non-unique so store as an array of items for each key
            let keys: string[];
            if (this._indexSchema.fullText) {
                keys = _.map(FullTextSearchHelpers.getFullTextIndexWordsForItem(<string>this._keyPath, item), val =>
                    NoSqlProviderUtils.serializeKeyToString(val, <string>this._keyPath));
            } else if (this._indexSchema.multiEntry) {
                // Have to extract the multiple entries into this alternate table...
                const valsRaw = NoSqlProviderUtils.getValueForSingleKeypath(item, <string>this._keyPath);
                if (valsRaw) {
                    keys = _.map(NoSqlProviderUtils.arrayify(valsRaw), val =>
                        NoSqlProviderUtils.serializeKeyToString(val, <string>this._keyPath));
                }
            } else {
                keys = [NoSqlProviderUtils.getSerializedKeyForKeypath(item, this._keyPath)];
            }

            _.each(keys, key => {
                if (!data[key]) {
                    data[key] = [item];
                } else {
                    data[key].push(item);
                }
            });
        });
        return data;
    }

    getAll<T>(reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }

        let data: _.Dictionary<any>;
        const err = _.attempt(() => {
            data = this._calcChunkedData();
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        const sortedKeys = _.keys(data).sort();
        return this._returnResultsFromKeys(data, sortedKeys, reverse, limit, offset);
    }

    getOnly<T>(key: any | any[], reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        return this.getRange(key, key, false, false, reverse, limit, offset);
    }

    getRange<T>(keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
            reverse?: boolean, limit?: number, offset?: number): SyncTasks.Promise<T[]> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }

        let data: _.Dictionary<any>;
        let sortedKeys: string[];
        const err = _.attempt(() => {
            data = this._calcChunkedData();
            sortedKeys = this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).sort();
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        return this._returnResultsFromKeys(data, sortedKeys, reverse, limit, offset);
    }

    // Warning: This function can throw, make sure to trap.
    private _getKeysForRange(data: _.Dictionary<any>, keyLowRange: any | any[], keyHighRange: any | any[], lowRangeExclusive?: boolean,
            highRangeExclusive?: boolean): string[] {
        const keyLow = NoSqlProviderUtils.serializeKeyToString(keyLowRange, this._keyPath);
        const keyHigh = NoSqlProviderUtils.serializeKeyToString(keyHighRange, this._keyPath);
        return _.filter(_.keys(data), key =>
            (key > keyLow || (key === keyLow && !lowRangeExclusive)) && (key < keyHigh || (key === keyHigh && !highRangeExclusive)));
    }

    private _returnResultsFromKeys(data: _.Dictionary<any>, sortedKeys: string[], reverse?: boolean, limit?: number, offset?: number) {
        if (reverse) {
            sortedKeys = _(sortedKeys).reverse().value();
        }

        if (offset) {
            sortedKeys = sortedKeys.slice(offset);
        }

        if (limit) {
            sortedKeys = sortedKeys.slice(0, limit);
        }

        let results = _.map(sortedKeys, key => data[key]);
        return SyncTasks.Resolved(_.flatten(results));
    }

    countAll(): SyncTasks.Promise<number> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }
        let data: _.Dictionary<any>;
        const err = _.attempt(() => {
            data = this._calcChunkedData();
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }
        return SyncTasks.Resolved(_.keys(data).length);
    }

    countOnly(key: any|any[]): SyncTasks.Promise<number> {
        return this.countRange(key, key, false, false);
    }

    countRange(keyLowRange: any|any[], keyHighRange: any|any[], lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
            : SyncTasks.Promise<number> {
        if (!this._trans.internal_isOpen()) {
            return SyncTasks.Rejected('InMemoryTransaction already closed');
        }

        let keys: string[];
        const err = _.attempt(() => {
            const data = this._calcChunkedData();
            keys = this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (err) {
            return SyncTasks.Rejected(err);
        }

        return SyncTasks.Resolved(keys.length);
    }
}
