import { useEffect, useState } from 'react';
import { ALL_AGENTS_PROJECT, formatProjectLabel } from '../../lib/settings/local-settings';

interface ProjectSelectorProps {
  currentProject: string;
  recentProjects: string[];
  onProjectChange: (project: string) => void;
}

export function ProjectSelector({
  currentProject,
  recentProjects,
  onProjectChange,
}: ProjectSelectorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState(currentProject === ALL_AGENTS_PROJECT ? '' : currentProject);

  useEffect(() => {
    setInputValue(currentProject === ALL_AGENTS_PROJECT ? '' : currentProject);
  }, [currentProject]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (trimmed) {
      onProjectChange(trimmed);
    }
    setIsEditing(false);
  };

  const handleSelect = (project: string) => {
    onProjectChange(project);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <form className="project-selector-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Project name"
          autoFocus
          className="project-input"
        />
        <button type="submit" className="project-submit">
          Set
        </button>
        <button
          type="button"
          className="project-cancel"
          onClick={() => {
            setInputValue(currentProject === ALL_AGENTS_PROJECT ? '' : currentProject);
            setIsEditing(false);
          }}
        >
          ×
        </button>
        <button
          type="button"
          className="recent-project-btn"
          onClick={() => handleSelect(ALL_AGENTS_PROJECT)}
        >
          All agents
        </button>
        {recentProjects.length > 0 && (
          <div className="recent-projects">
            <span className="recent-label">Recent:</span>
            {recentProjects.map((project) => (
              <button
                key={project}
                type="button"
                className="recent-project-btn"
                onClick={() => handleSelect(project)}
              >
                {project}
              </button>
            ))}
          </div>
        )}
      </form>
    );
  }

  return (
    <button
      className="project-selector-btn"
      onClick={() => setIsEditing(true)}
      title="Click to change project"
    >
      {formatProjectLabel(currentProject)}
    </button>
  );
}
