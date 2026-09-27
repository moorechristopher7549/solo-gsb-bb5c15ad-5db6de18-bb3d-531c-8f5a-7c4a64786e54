import type { Conflict } from '../App';

interface ConflictBannerProps {
  conflict: Conflict;
  titleOf: (id: string) => string;
  onClose: () => void;
}

export default function ConflictBanner({ conflict, titleOf, onClose }: ConflictBannerProps) {
  const chain = conflict.cycle.map(titleOf).join(' → ');
  const isMerge = conflict.merge !== undefined;
  return (
    <div className="toast conflict" role="alert">
      <div>
        <strong>⚠ 已拒绝{isMerge ? '合并' : '保存'}：{conflict.message}</strong>
        <div className="conflict-chain">
          {isMerge
            ? conflict.merge!.kind === 'self-loop'
              ? <>冲突：「{titleOf(conflict.merge!.sourceId)}」与「{titleOf(conflict.merge!.targetId)}」之间已有直接约束，改接后会变成卡片指向自身的自环</>
              : <>冲突路径：<b>{chain}</b></>
            : <>冲突闭环：<b>{chain}</b></>}
        </div>
        <div className="muted">
          {isMerge
            ? '本次合并已在单个事务内整体回滚，未删除任何卡片、未改接任何连线。路径中的卡片与连线已标红。'
            : '「必须早于」关系不能构成环，否则时间线无法成立。闭环中的卡片与连线已标红。'}
        </div>
      </div>
      <button className="toast-close" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </div>
  );
}
