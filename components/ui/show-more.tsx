import React from "react";

interface ShowMoreProps {
  expanded: boolean;
  onClick: React.Dispatch<React.SetStateAction<boolean>>;
  noBorder?: boolean;
  className?: string;
  loading?: boolean;
}

export const ShowMore = ({
  expanded = false,
  onClick,
  className = "",
  loading = false,
}: ShowMoreProps) => {
  return (
    <div
      className={`w-[calc(100%_-_40px)] flex items-center justify-center min-h-[30px] ${className}`}
    >
      <div className="rounded-[99px] bg-background">
        <button
          type="button"
          className="h-8 px-3 text-sm rounded-[100px] text-gray-1000 font-sans bg-background-100 font-medium border border-gray-alpha-400 duration-150 hover:opacity-80 transition-opacity"
          onClick={() => !loading && onClick(!expanded)}
          disabled={loading}
          aria-busy={loading}
        >
          <span className="text-nowrap inline-block">
            <div className="flex items-center">
              {loading ? "Loading" : `Show ${expanded ? "Less" : "More"}`}
              {loading ? (
                <span className="inline-flex ml-1.5 w-4 h-4 rounded-full border-2 border-gray-alpha-400 border-t-gray-1000 animate-spin" />
              ) : (
              <span
                className={`inline-flex ml-1 duration-200${
                  expanded ? " rotate-180" : ""
                }`}
              >
                <svg
                  height="16"
                  strokeLinejoin="round"
                  viewBox="0 0 16 16"
                  width="16"
                  className="fill-gray-1000"
                >
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M12.0607 6.74999L11.5303 7.28032L8.7071 10.1035C8.31657 10.4941 7.68341 10.4941 7.29288 10.1035L4.46966 7.28032L3.93933 6.74999L4.99999 5.68933L5.53032 6.21966L7.99999 8.68933L10.4697 6.21966L11 5.68933L12.0607 6.74999Z"
                  />
                </svg>
              </span>
              )}
            </div>
          </span>
        </button>
      </div>
    </div>
  );
};
