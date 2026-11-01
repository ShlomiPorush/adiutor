// Opening an item and the one-click item actions. An item opens as a dialog over the current page
// with its own address (?item=<id>), so Back closes it and the link can be shared. A status, type or
// project change acts at once and offers Undo for ten seconds (v3 FB-16): Undo sends every field the
// change altered back to its previous value (undo.ts), with the version the change returned, so it
// cannot undo someone else's later change.

import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router"
import type { ItemStatus, ItemType } from "../../shared/enums.ts"
import { ApiError } from "../api/client.ts"
import { api, qk } from "../api/endpoints.ts"
import type { Item, ItemDetail, ItemPatch } from "../api/types.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { errorReason } from "../ui/states.tsx"
import { showToast } from "../ui/Toast.tsx"
import { type UndoState, undoPatch } from "./undo.ts"

export const ITEM_PARAM = "item"

export function useOpenItem(): (itemId: string) => void {
  const [, setParams] = useSearchParams()
  return useCallback(
    (itemId: string) => {
      setParams(
        (params) => {
          params.set(ITEM_PARAM, itemId)
          return params
        },
        { state: { itemInApp: true } },
      )
    },
    [setParams],
  )
}

/** Closes the item dialog: Back when the app opened it, else the address loses ?item= in place. */
export function useCloseItem(): () => void {
  const location = useLocation()
  const navigate = useNavigate()
  const [, setParams] = useSearchParams()
  const inApp = (location.state as { itemInApp?: boolean } | null)?.itemInApp === true
  return useCallback(() => {
    if (inApp) {
      navigate(-1)
      return
    }
    setParams(
      (params) => {
        params.delete(ITEM_PARAM)
        return params
      },
      { replace: true },
    )
  }, [inApp, navigate, setParams])
}

/** Everything that shows items reads again after a change. */
export function useRefreshItems(): () => Promise<void> {
  const queryClient = useQueryClient()
  return useCallback(async () => {
    await Promise.all(
      [qk.morning, qk.projects, ["project"], qk.inbox, qk.archive, qk.audit, ["item"]].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    )
  }, [queryClient])
}

type ItemRef = { id: string; version: number; title: string } & UndoState

export function useItemActions() {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const refresh = useRefreshItems()

  // The item dialog shows the new version at once; its project and goal follow on the next read.
  const keep = useCallback(
    (next: Item) =>
      queryClient.setQueryData<ItemDetail>(qk.item(next.id), (old) => (old ? { ...old, item: next } : old)),
    [queryClient],
  )

  const change = useCallback(
    async (
      item: ItemRef,
      patch: ItemPatch,
      undoable: boolean,
      message: string,
      undoLabel: string,
    ): Promise<Item | null> => {
      try {
        const next = await api.updateItem(item.id, item.version, patch)
        keep(next)
        await refresh()
        const undo = undoable ? undoPatch(item, next) : null
        showToast(
          message,
          "success",
          undo
            ? {
                action: {
                  label: t("common.undo"),
                  ariaLabel: undoLabel,
                  onAction: async () => {
                    try {
                      keep(await api.updateItem(item.id, next.version, undo))
                      await refresh()
                      showToast(t("toast.undone", { title: item.title }), "success")
                    } catch (error) {
                      const reason =
                        error instanceof ApiError && error.code === "version_conflict"
                          ? t("toast.changedSince")
                          : errorReason(language, error)
                      showToast(t("toast.undoFailed", { reason }), "error")
                      await refresh()
                    }
                  },
                },
              }
            : {},
        )
        return next
      } catch (error) {
        if (error instanceof ApiError && error.code === "version_conflict") {
          showToast(t("toast.versionConflict", { title: item.title }), "warning")
        } else {
          showToast(t("toast.changeFailed", { title: item.title, reason: errorReason(language, error) }), "error")
        }
        await refresh()
        return null
      }
    },
    [keep, language, refresh, t],
  )

  return {
    setStatus: (item: ItemRef, status: ItemStatus) =>
      change(
        item,
        { status },
        true,
        t("toast.statusSet", { title: item.title, status: t(`itemStatus.${status}`) }),
        t("toast.undoStatus", { title: item.title }),
      ),
    setType: (item: ItemRef, type: ItemType) =>
      change(
        item,
        { type },
        true,
        t("toast.typeSet", { title: item.title, type: t(`itemType.${type}`) }),
        t("toast.undoType", { title: item.title }),
      ),
    moveTo: (item: ItemRef, projectId: string | null, projectName: string | null) =>
      change(
        item,
        { projectId },
        true,
        projectId
          ? t("toast.moved", { title: item.title, project: projectName ?? "" })
          : t("toast.movedToInbox", { title: item.title }),
        t("toast.undoMove", { title: item.title }),
      ),
    update: (item: ItemRef, patch: ItemPatch, message: string) => change(item, patch, false, message, ""),
  }
}
