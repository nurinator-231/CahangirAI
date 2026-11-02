package com.cahangir.assistant.sync

import org.junit.Assert.*
import org.junit.Test

class SyncRulesTest {
    @Test fun appliesWhenNoLocalCopy() = assertTrue(SyncRules.shouldApplyServerItem(null, false, 100L))
    @Test fun keepsNewerLocalEdit() = assertFalse(SyncRules.shouldApplyServerItem(200L, false, 100L))
    @Test fun keepsPendingLocalOnTie() = assertFalse(SyncRules.shouldApplyServerItem(100L, true, 100L))
    @Test fun appliesNewerServerOverSyncedLocal() = assertTrue(SyncRules.shouldApplyServerItem(100L, false, 200L))
    @Test fun appliesNewerServerOverPendingOlderLocal() = assertTrue(SyncRules.shouldApplyServerItem(100L, true, 200L))
    @Test fun appliesOnTieWhenLocalSynced() = assertTrue(SyncRules.shouldApplyServerItem(100L, false, 100L))
}
