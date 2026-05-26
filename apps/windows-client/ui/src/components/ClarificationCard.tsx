import { ChoiceButton } from './ui/ChoiceButton';

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
          <ChoiceButton
            key={option.label}
            className="clarification-option"
            label={option.label}
            detail={option.detail}
            selected={answer === option.label}
            disabled={Boolean(answer)}
            onClick={() => onAnswer(option)}
          />
        ))}
      </div>
    </div>
  );
}
