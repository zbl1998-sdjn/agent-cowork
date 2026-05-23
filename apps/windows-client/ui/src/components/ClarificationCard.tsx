export interface ClarificationOption {
  label: string;
  detail?: string;
  recipeId?: string;
}

export interface ClarificationCardProps {
  question: string;
  options: ClarificationOption[];
  answer?: string;
  onAnswer: (option: ClarificationOption) => void;
}

export function ClarificationCard({ question, options, answer, onAnswer }: ClarificationCardProps) {
  return (
    <div className="clarification-card">
      <div className="clarification-q">{question}</div>
      <div className="clarification-options">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={answer === option.label ? 'is-chosen' : ''}
            disabled={Boolean(answer)}
            onClick={() => onAnswer(option)}
          >
            <strong>{option.label}</strong>
            {option.detail && <span>{option.detail}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
