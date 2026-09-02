import React from "react";

/**
 * ISSUE-032：统一加载态组件。
 * - LoadingBlock：占位型，用于列表/区块内联显示「正在干什么…」（低龄友好，复用 .working-spinner）。
 * - PageLoading：整页门控型，loading 期间整页覆盖显示「正在干什么…」，加载完才渲染页面。
 * 文案必须具体化（如「正在加载孩子列表…」），不得用笼统的「加载中」。
 */

/** 占位型加载提示：内联在列表/区块中，留出空间并提示正在干什么 */
export function LoadingBlock({ text }: { text?: string }) {
  return (
    <div className="loading-block">
      <span className="working-spinner" />
      {text ? <span className="loading-text">{text}</span> : null}
    </div>
  );
}

/** 整页门控型加载：覆盖整页，直到数据加载完成才显示真实页面 */
export function PageLoading({ text }: { text?: string }) {
  return (
    <div className="page-loading">
      <span className="working-spinner working-spinner-lg" />
      {text ? <div className="page-loading-text">{text}</div> : null}
    </div>
  );
}
