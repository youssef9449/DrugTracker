import type { FC } from 'react';

export const AndroidNavBar: FC = () => {
  return (
    <div className="w-full h-5 bg-slate-900 flex items-center justify-center select-none shrink-0">
      {/* Android gesture home indicator pill */}
      <div className="w-28 h-1 bg-white/40 rounded-full" />
    </div>
  );
};
